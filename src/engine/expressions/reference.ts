/**
 * Data references between nodes (docs/backend/11-CONDITIONS-AND-DATA-MAPPING.md).
 *
 *   trigger.issue.title
 *   steps.classify.output.priority
 *   trigger.issue.labels.0.name
 *
 * A closed grammar, parsed by hand: no expression language, no eval, no functions.
 * Resolution reads own properties of plain JSON only, so prototype tricks cannot work.
 */

export type PathSegment = string | number;

export interface Reference {
  /** Source text, for error messages. */
  text: string;
  root: 'trigger' | 'steps';
  /** For `steps.<key>.output…` references. */
  nodeKey?: string;
  /** Path below `trigger` or below `steps.<key>.output`. */
  path: PathSegment[];
}

export class ReferenceSyntaxError extends Error {
  constructor(text: string, reason: string) {
    super(`Invalid reference "${text}": ${reason}`);
    this.name = 'ReferenceSyntaxError';
  }
}

const MAX_SEGMENTS = 20;
const MAX_LENGTH = 300;
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const INDEX = /^\d{1,6}$/;
const NODE_KEY = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;
const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);

export function parseReference(text: string): Reference {
  if (typeof text !== 'string' || text.length === 0) {
    throw new ReferenceSyntaxError(String(text), 'empty');
  }
  if (text.length > MAX_LENGTH) throw new ReferenceSyntaxError(text.slice(0, 40), 'too long');

  const segments = text.split('.');
  if (segments.length > MAX_SEGMENTS) throw new ReferenceSyntaxError(text, 'too many segments');

  let root: Reference['root'];
  let nodeKey: string | undefined;
  let rest: string[];

  if (segments[0] === 'trigger') {
    root = 'trigger';
    rest = segments.slice(1);
  } else if (segments[0] === 'steps') {
    root = 'steps';
    nodeKey = segments[1];
    if (!nodeKey || !NODE_KEY.test(nodeKey)) {
      throw new ReferenceSyntaxError(text, 'expected steps.<nodeKey>.output');
    }
    if (segments[2] !== 'output') {
      throw new ReferenceSyntaxError(text, 'step references must continue with ".output"');
    }
    rest = segments.slice(3);
  } else {
    throw new ReferenceSyntaxError(text, 'must start with "trigger" or "steps"');
  }

  const path = rest.map((segment): PathSegment => {
    if (FORBIDDEN.has(segment)) throw new ReferenceSyntaxError(text, `"${segment}" is not allowed`);
    if (INDEX.test(segment)) return Number(segment);
    if (IDENTIFIER.test(segment)) return segment;
    throw new ReferenceSyntaxError(text, `invalid segment "${segment}"`);
  });

  return { text, root, nodeKey, path };
}

/** Marker for "the referenced value does not exist" (distinct from JSON null). */
export const MISSING: unique symbol = Symbol('missing');
export type Resolved = unknown | typeof MISSING;

/** What references can see: the trigger output and earlier steps' outputs. */
export interface ReferenceScope {
  trigger: unknown;
  outputs: Readonly<Record<string, unknown>>;
}

export function resolveReference(ref: Reference, scope: ReferenceScope): Resolved {
  let current: unknown;
  if (ref.root === 'trigger') {
    current = scope.trigger;
  } else {
    if (!Object.hasOwn(scope.outputs, ref.nodeKey!)) return MISSING;
    current = scope.outputs[ref.nodeKey!];
  }

  for (const segment of ref.path) {
    if (current === null || typeof current !== 'object') return MISSING;
    if (Array.isArray(current)) {
      if (typeof segment !== 'number' || segment >= current.length) return MISSING;
      current = current[segment];
    } else {
      // Own, enumerable data properties only — never the prototype chain.
      if (typeof segment !== 'string' || !Object.hasOwn(current, segment)) return MISSING;
      current = (current as Record<string, unknown>)[segment];
    }
  }
  return current === undefined ? MISSING : current;
}
