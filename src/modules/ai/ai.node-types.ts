import { ErrorCategory } from '@prisma/client';
import { createHash } from 'node:crypto';
import { ZodType, ZodTypeDef } from 'zod';
import { NodeTypeDefinition } from '../../engine/catalog/node-type-catalog';
import { PermanentError } from '../../engine/errors';
import { NodeHandler } from '../../engine/execution/node-handler';
import { AiProvider } from './ai-provider';
import {
  AiTask,
  classifyConfigSchema,
  classifyTask,
  extractConfigSchema,
  extractTask,
  runAiTask,
  summarizeConfigSchema,
  summarizeTask,
  toAiText,
} from './ai-tasks';

interface AiAction {
  type: string;
  displayName: string;
  configSchema: ZodType;
  /** Validated config → task. */
  task: (config: unknown) => AiTask<object>;
}

/** Ties each action's task to its own config schema's output type. */
const action = <C>(def: {
  type: string;
  displayName: string;
  configSchema: ZodType<C, ZodTypeDef, unknown>;
  task: (config: C) => AiTask<object>;
}): AiAction => def as unknown as AiAction;

const ACTIONS: AiAction[] = [
  action({
    type: 'ai.summarize',
    displayName: 'AI: summarise text',
    configSchema: summarizeConfigSchema,
    task: summarizeTask,
  }),
  action({
    type: 'ai.classify',
    displayName: 'AI: classify text',
    configSchema: classifyConfigSchema,
    task: classifyTask,
  }),
  action({
    type: 'ai.extract',
    displayName: 'AI: extract fields',
    configSchema: extractConfigSchema,
    task: extractTask,
  }),
];

export const AI_NOT_CONFIGURED = 'No AI provider is configured on this server (AI_PROVIDER)';

/** AI node types; marked unavailable (rejected on publish) when no provider is configured. */
export function aiNodeTypes(configured: boolean): NodeTypeDefinition[] {
  return ACTIONS.map(({ type, displayName, configSchema }) => ({
    type,
    kind: 'ACTION',
    displayName,
    configSchema,
    ...(!configured && { unavailableReason: AI_NOT_CONFIGURED }),
  }));
}

export interface AiSettings {
  maxInputChars: number;
  maxOutputTokens: number;
}

const fingerprint = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);

/**
 * Worker handlers. No credentials in the workflow: the provider holds the server's key.
 * Idempotent: no external state changes, so re-running after a crash is safe (it only
 * costs tokens). Prompts and outputs are logged as lengths and hashes, never content.
 */
export function createAiHandlers(provider: AiProvider | null, settings: AiSettings): NodeHandler[] {
  return ACTIONS.map((def): NodeHandler => ({
    type: def.type,
    kind: 'ACTION',
    sideEffect: 'idempotent',
    async execute({ config, signal, logger }) {
      if (!provider) {
        throw new PermanentError(ErrorCategory.PERMANENT_PROVIDER_ERROR, AI_NOT_CONFIGURED);
      }
      const text = toAiText(config.text);
      if (!text.trim()) {
        throw new PermanentError(ErrorCategory.VALIDATION, 'AI step text is empty after rendering');
      }
      const parsed = def.configSchema.safeParse({ ...config, text });
      if (!parsed.success) {
        throw new PermanentError(ErrorCategory.VALIDATION, 'Invalid AI step configuration');
      }
      const result = await runAiTask(provider, def.task(parsed.data), text, {
        ...settings,
        signal,
      });
      logger.info('AI step completed', {
        action: def.type,
        provider: provider.name,
        model: result.usage?.model,
        attempts: result.meta.attempts,
        inputChars: result.meta.inputChars,
        inputSha256: fingerprint(text),
        outputChars: JSON.stringify(result.value).length,
        truncated: result.meta.truncated,
      });
      return {
        output: {
          ...result.value,
          ...(result.usage && { usage: result.usage }),
          meta: result.meta,
        },
      };
    },
  }));
}
