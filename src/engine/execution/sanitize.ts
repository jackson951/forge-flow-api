import { redactSecrets } from '../../common/security/redaction';

/**
 * Prepares values for persistence on StepRun (input/output): plain JSON, with credential-like
 * keys and token-shaped values redacted (shared redactor, Part 17).
 */
export { REDACTED } from '../../common/security/redaction';

export function sanitizeForStorage(value: unknown): unknown {
  return redactSecrets(toPlainJson(value));
}

/** JSON round-trip: drops functions/undefined, turns Dates into strings, rejects cycles. */
export function toPlainJson(value: unknown): unknown {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value)) as unknown;
}

export const jsonByteLength = (value: unknown) =>
  Buffer.byteLength(JSON.stringify(value ?? null), 'utf8');
