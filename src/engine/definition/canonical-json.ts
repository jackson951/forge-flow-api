import { createHash } from 'node:crypto';

/**
 * JSON with object keys sorted recursively (array order preserved), so equivalent
 * definitions serialize, and therefore hash, identically.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

export function definitionHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
  );
}
