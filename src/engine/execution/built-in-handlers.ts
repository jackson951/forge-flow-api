import { ErrorCategory } from '@prisma/client';
import { PermanentError } from '../errors';
import { conditionConfigSchema, evaluateCondition } from '../expressions/conditions';
import { ReferenceSyntaxError } from '../expressions/reference';
import { NodeHandler } from './node-handler';

/** The trigger's output is the run's trigger input (manual input or normalised event). */
export const manualTriggerHandler: NodeHandler = {
  type: 'manual.trigger',
  kind: 'TRIGGER',
  sideEffect: 'none',
  execute: async ({ triggerInput }) => ({ output: triggerInput ?? {} }),
};

export const logHandler: NodeHandler<{ message: string }> = {
  type: 'util.log',
  kind: 'ACTION',
  sideEffect: 'none',
  execute: async ({ config, logger }) => {
    logger.info('Workflow log step', { length: config.message.length });
    return { output: { message: config.message } };
  },
};

/**
 * Evaluates the structured condition against the trigger output and earlier steps' outputs.
 * Pure data evaluation (Part 11) — no code execution.
 */
export const conditionHandler: NodeHandler = {
  type: 'condition',
  kind: 'CONDITION',
  sideEffect: 'none',
  execute: async ({ config, triggerInput, outputs }) => {
    const parsed = conditionConfigSchema.safeParse(config);
    if (!parsed.success) {
      throw new PermanentError(ErrorCategory.VALIDATION, 'Invalid condition configuration');
    }
    try {
      return {
        output: { result: evaluateCondition(parsed.data, { trigger: triggerInput, outputs }) },
      };
    } catch (err) {
      if (err instanceof ReferenceSyntaxError) {
        throw new PermanentError(ErrorCategory.VALIDATION, err.message);
      }
      throw err;
    }
  },
};

export const BUILT_IN_HANDLERS: NodeHandler[] = [
  manualTriggerHandler,
  logHandler as NodeHandler,
  conditionHandler,
];
