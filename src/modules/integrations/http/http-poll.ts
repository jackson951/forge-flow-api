import { createHash } from 'node:crypto';
import { canonicalJson } from '../../../engine/definition/canonical-json';

/**
 * Pure helpers of the http.poll trigger (Part 24, FR-24.16): item extraction, identity,
 * cursor and the state's config fingerprint.
 */

export const DOT_PATH = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+){0,9}$/;
/** Seen-id window kept in HttpPollState; the unique run key protects beyond it. */
export const MAX_SEEN_IDS = 2_000;
const MAX_ID_LENGTH = 200;

export class PollDataError extends Error {}

export function getPath(value: unknown, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>(
      (node, key) =>
        node !== null && typeof node === 'object'
          ? (node as Record<string, unknown>)[key]
          : undefined,
      value,
    );
}

/** The items of a response: the array at `path`, or the whole response as one item. */
export function extractItems(body: unknown, path?: string): unknown[] {
  if (!path) return body === null || body === undefined ? [] : [body];
  const found = getPath(body, path);
  if (found === undefined || found === null) return [];
  if (!Array.isArray(found)) throw new PollDataError(`"${path}" in the response is not a list`);
  return found;
}

/** An item's identity: its id field (string/number), or a hash of its content. */
export function itemIdentity(item: unknown, path?: string): string {
  if (path) {
    const id = getPath(item, path);
    if ((typeof id === 'string' && id.trim()) || typeof id === 'number') {
      const text = String(id).trim();
      return text.length <= MAX_ID_LENGTH ? text : `sha256:${sha256(text)}`;
    }
    throw new PollDataError(`An item has no usable id at "${path}"`);
  }
  return `sha256:${sha256(canonicalJson(item ?? null))}`;
}

/** The next cursor from a response (string or number), if present. */
export function cursorFrom(body: unknown, path?: string): string | undefined {
  if (!path) return undefined;
  const value = getPath(body, path);
  if (typeof value === 'number') return String(value);
  return typeof value === 'string' && value.length <= 2_048 ? value : undefined;
}

/**
 * Items not seen before, in response order, without repeats inside the response. `seen` is
 * the stored window.
 */
export function newItems(
  items: unknown[],
  seen: Iterable<string>,
  identityPath?: string,
): { id: string; item: unknown }[] {
  const known = new Set(seen);
  const result: { id: string; item: unknown }[] = [];
  for (const item of items) {
    const id = itemIdentity(item, identityPath);
    if (known.has(id)) continue;
    known.add(id);
    result.push({ id, item });
  }
  return result;
}

/** Appends ids to the window, newest last, keeping at most MAX_SEEN_IDS. */
export function rememberIds(seen: string[], ids: string[]): string[] {
  const merged = [...seen.filter((id) => !ids.includes(id)), ...ids];
  return merged.slice(-MAX_SEEN_IDS);
}

/** The settings the poll state belongs to; changing any of them starts from scratch. */
export function pollConfigHash(config: {
  connectionId?: string;
  request: unknown;
  items: unknown;
  identity: unknown;
  cursor?: unknown;
}): string {
  return sha256(
    canonicalJson({
      connectionId: config.connectionId ?? null,
      request: config.request,
      items: config.items,
      identity: config.identity,
      cursor: config.cursor ?? null,
    }),
  );
}

/** Backoff while failing: from the 3rd consecutive failure, 1, 2, 4 … up to 60 minutes. */
export function backoffMs(consecutiveFailures: number): number | null {
  if (consecutiveFailures < 3) return null;
  return Math.min(2 ** (consecutiveFailures - 3) * 60_000, 60 * 60_000);
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
