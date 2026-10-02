export interface AiUsage {
  inputTokens: number;
  outputTokens: number;
  model: string;
}

export interface AiRequest {
  /** Server-side instructions (never user text). */
  system: string;
  /** User message; untrusted text is inside a delimited data section. */
  prompt: string;
  /** JSON Schema of the expected object; providers use their structured-output feature. */
  jsonSchema: Record<string, unknown>;
  maxOutputTokens: number;
  /** Aborted when the step times out or is cancelled. */
  signal: AbortSignal;
}

/**
 * A model response. `json` when the provider returned structured output, otherwise `text`
 * (parsed as JSON by the caller). Either way the content is untrusted until validated.
 */
export interface AiCompletion {
  json?: unknown;
  text?: string;
  usage?: AiUsage;
}

/**
 * Hosted model behind one call. Implementations map failures to execution errors
 * (timeouts, rate limits, auth) and never put the API key or response bodies in messages.
 */
export interface AiProvider {
  readonly name: string;
  complete(request: AiRequest): Promise<AiCompletion>;
}

/** Null when no provider is configured (AI_PROVIDER unset). */
export const AI_PROVIDER = Symbol('AI_PROVIDER');
