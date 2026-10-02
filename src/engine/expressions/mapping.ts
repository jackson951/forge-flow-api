import { MISSING, parseReference, ReferenceScope, resolveReference } from './reference';

/**
 * Node input mapping:
 * - a string may contain `{{ <reference> }}` placeholders; the result is a string
 *   (objects/arrays are JSON-encoded, missing values render as "")
 * - an object of exactly `{ "ref": "<reference>" }` is replaced by the referenced value with
 *   its type preserved (missing → null)
 * Single pass: a resolved value is never interpreted again, so data cannot inject templates.
 */

export const TEMPLATE_PATTERN = /\{\{\s*([^{}\s]+)\s*\}\}/g;
export const MAX_RENDERED_LENGTH = 16 * 1024;

export class MappingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MappingError';
  }
}

export interface MappingResult {
  value: unknown;
  /** References that resolved to nothing (rendered as "" or null). */
  missing: string[];
}

export function isRefObject(value: unknown): value is { ref: string } {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    typeof (value as { ref?: unknown }).ref === 'string'
  );
}

export function renderTemplate(
  template: string,
  scope: ReferenceScope,
  missing: string[] = [],
): string {
  const rendered = template.replace(TEMPLATE_PATTERN, (_match, text: string) => {
    const value = resolveReference(parseReference(text), scope);
    if (value === MISSING || value === null) {
      if (value === MISSING) missing.push(text);
      return '';
    }
    return typeof value === 'object' ? JSON.stringify(value) : String(value);
  });
  if (rendered.length > MAX_RENDERED_LENGTH) {
    throw new MappingError(`Rendered text exceeds ${MAX_RENDERED_LENGTH / 1024} KB`);
  }
  return rendered;
}

/** Resolves every template and `{ ref }` in a config tree. */
export function mapConfig(config: unknown, scope: ReferenceScope): MappingResult {
  const missing: string[] = [];
  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') return renderTemplate(value, scope, missing);
    if (Array.isArray(value)) return value.map(walk);
    if (value === null || typeof value !== 'object') return value;
    if (isRefObject(value)) {
      const resolved = resolveReference(parseReference(value.ref), scope);
      if (resolved === MISSING) {
        missing.push(value.ref);
        return null;
      }
      return resolved;
    }
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v)]));
  };
  return { value: walk(config), missing };
}

/**
 * Every reference text used in a config tree: `{ ref }` objects and, unless disabled,
 * `{{ }}` templates in strings. Condition configs pass `templates: false` because their
 * `value` operands are literals.
 */
export function collectReferences(config: unknown, { templates = true } = {}): string[] {
  const found: string[] = [];
  const walk = (value: unknown) => {
    if (typeof value === 'string') {
      if (!templates) return;
      for (const match of value.matchAll(TEMPLATE_PATTERN)) found.push(match[1]);
    } else if (Array.isArray(value)) {
      value.forEach(walk);
    } else if (value !== null && typeof value === 'object') {
      if (isRefObject(value)) found.push(value.ref);
      else Object.values(value).forEach(walk);
    }
  };
  walk(config);
  return found;
}
