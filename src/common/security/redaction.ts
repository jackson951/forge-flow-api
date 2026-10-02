/**
 * Shared secret redaction (docs/backend/17-INTEGRATION-CREDENTIAL-SECURITY.md). Pure, no I/O.
 * Used for persisted step input/output, log lines and workflow-definition checks.
 *
 * Two independent nets:
 * - key-based: properties named like credentials are blanked whatever their value
 * - value-based: token-shaped substrings are blanked wherever they appear
 */

export const REDACTED = '[REDACTED]';

/** Credential-like property names. Exact-shape match, so e.g. `maxTokens` stays visible. */
export const SECRET_KEY =
  /^(access_?|refresh_?|api_?|auth_?|bearer_?|client_?|private_?|id_?)?(token|secret|password|passwd|apikey|authorization|privatekey|cookie)$/i;

/** Shapes of real credentials. Deliberately specific to keep false positives low. */
const TOKEN_PATTERNS: RegExp[] = [
  /xox[abposr]-[A-Za-z0-9-]{10,}/g, // Slack
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g, // GitHub fine-grained PAT
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, // JWT (e.g. Graph tokens)
  /\bBearer\s+[A-Za-z0-9._~+/=-]{10,}/gi, // Authorization header values
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, // PEM keys
  /\bsk-(ant-)?[A-Za-z0-9_-]{20,}/g, // AI provider keys
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key ids
];

export function looksLikeSecret(value: string): boolean {
  return TOKEN_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(value);
  });
}

export function redactString(value: string): string {
  return TOKEN_PATTERNS.reduce((text, pattern) => text.replace(pattern, REDACTED), value);
}

/** Deep copy with credential-like keys and token-shaped substrings replaced. */
export function redactSecrets<T>(value: T, depth = 0): T {
  if (depth > 20) return REDACTED as T;
  if (typeof value === 'string') return redactString(value) as T;
  if (Array.isArray(value)) return value.map((v) => redactSecrets(v, depth + 1)) as T;
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Error) {
    return { name: value.name, message: redactString(value.message) } as T;
  }
  // Only plain data is rewritten. Class instances (e.g. the HTTP request/response pino-http
  // passes to the logger, Dates, Buffers) are left for their serializers and path redaction.
  const proto = Object.getPrototypeOf(value) as unknown;
  if (proto !== Object.prototype && proto !== null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      SECRET_KEY.test(key) ? REDACTED : redactSecrets(child, depth + 1),
    ]),
  ) as T;
}
