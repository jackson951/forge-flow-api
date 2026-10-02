import { ErrorCategory } from '@prisma/client';
import { ExecutionError, PermanentError, RetryableError } from '../../engine/errors';
import { AiCompletion, AiProvider, AiRequest } from './ai-provider';

const API_VERSION = '2023-06-01';
const TOOL_NAME = 'respond';

export interface AnthropicOptions {
  apiKey: string;
  apiUrl: string;
  model: string;
  timeoutMs: number;
}

interface MessagesResponse {
  model?: string;
  content?: ({ type: 'tool_use'; name: string; input: unknown } | { type: 'text'; text: string })[];
  usage?: { input_tokens?: number; output_tokens?: number };
}

/**
 * Anthropic Messages API (no SDK). Structured output through a single forced tool whose
 * input schema is the expected object, so the model answers with JSON arguments rather
 * than prose. The result is still validated by the caller.
 */
export class AnthropicProvider implements AiProvider {
  readonly name = 'anthropic';

  constructor(
    private readonly options: AnthropicOptions,
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
  ) {}

  async complete(request: AiRequest): Promise<AiCompletion> {
    const timeout = AbortSignal.timeout(this.options.timeoutMs);
    const signal = AbortSignal.any([request.signal, timeout]);
    let body: MessagesResponse;
    try {
      const res = await this.fetchImpl(`${this.options.apiUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.options.apiKey,
          'anthropic-version': API_VERSION,
        },
        body: JSON.stringify({
          model: this.options.model,
          max_tokens: request.maxOutputTokens,
          system: request.system,
          messages: [{ role: 'user', content: request.prompt }],
          tools: [
            {
              name: TOOL_NAME,
              description: 'Return the result. Always call this tool exactly once.',
              input_schema: request.jsonSchema,
            },
          ],
          tool_choice: { type: 'tool', name: TOOL_NAME },
        }),
        signal,
      });
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        throw mapAiProviderError(res.status, res.headers);
      }
      body = (await res.json()) as MessagesResponse;
    } catch (err) {
      if (err instanceof ExecutionError) throw err;
      // The engine's own timeout or a cancellation: let the engine classify it.
      if (request.signal.aborted) throw err;
      if (timeout.aborted) {
        throw new RetryableError(
          ErrorCategory.PROVIDER_TIMEOUT,
          `AI provider did not respond within ${this.options.timeoutMs} ms`,
        );
      }
      throw new RetryableError(
        ErrorCategory.TRANSIENT_INFRASTRUCTURE,
        'Could not reach the AI provider',
      );
    }

    const tool = body.content?.find((c) => c.type === 'tool_use' && c.name === TOOL_NAME);
    const text = body.content?.flatMap((c) => (c.type === 'text' ? [c.text] : [])).join('');
    return {
      ...(tool && 'input' in tool ? { json: tool.input } : { text: text ?? '' }),
      usage: body.usage && {
        inputTokens: body.usage.input_tokens ?? 0,
        outputTokens: body.usage.output_tokens ?? 0,
        model: body.model ?? this.options.model,
      },
    };
  }
}

/** HTTP status → execution error. Messages never include the response body. */
export function mapAiProviderError(status: number, headers: Headers): ExecutionError {
  if (status === 429) {
    const retryAfter = Number(headers.get('retry-after'));
    return new RetryableError(
      ErrorCategory.PROVIDER_RATE_LIMIT,
      'AI provider rate limit reached',
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 30_000,
    );
  }
  if (status === 401 || status === 403) {
    return new PermanentError(
      ErrorCategory.PROVIDER_AUTH,
      'AI provider rejected the server credentials',
    );
  }
  if (status === 408) {
    return new RetryableError(ErrorCategory.PROVIDER_TIMEOUT, 'AI provider request timed out');
  }
  // 5xx, including 529 "overloaded".
  if (status >= 500) {
    return new RetryableError(
      ErrorCategory.TRANSIENT_INFRASTRUCTURE,
      `AI provider returned ${status}`,
    );
  }
  return new PermanentError(
    ErrorCategory.PERMANENT_PROVIDER_ERROR,
    `AI provider rejected the request (${status})`,
  );
}
