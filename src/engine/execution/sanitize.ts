/**
 * Prepares values for persistence on StepRun (input/output). Minimal for now: credential-like
 * keys are redacted and the result is plain JSON. Part 17 extends this with value-based
 * redaction (token prefixes, bearer strings).
 */
const SECRET_KEY =
  /^(access_?|refresh_?|api_?|auth_?|bearer_?|client_?|private_?)?(token|secret|password|passwd|apikey|authorization)$/i;

export const REDACTED = '[REDACTED]';

export function sanitizeForStorage(value: unknown): unknown {
  return redact(toPlainJson(value));
}

/** JSON round-trip: drops functions/undefined, turns Dates into strings, rejects cycles. */
export function toPlainJson(value: unknown): unknown {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value)) as unknown;
}

export const jsonByteLength = (value: unknown) =>
  Buffer.byteLength(JSON.stringify(value ?? null), 'utf8');

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      SECRET_KEY.test(key) ? REDACTED : redact(child),
    ]),
  );
}
