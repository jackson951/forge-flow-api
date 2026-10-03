import { ErrorCategory } from '@prisma/client';
import { ExecutionError, PermanentError, RetryableError } from '../../../engine/errors';
import {
  EgressNetworkError,
  EgressResponse,
  EgressTimeoutError,
  isPermanentDnsError,
} from '../../../infrastructure/egress/egress-client';
import { EgressBlockedError } from '../../../infrastructure/egress/egress-policy';

/**
 * Pure helpers of the HTTP action (Part 24): URL resolution, request bodies, error
 * classification (FR-24.5 / Error Handling table) and the normalised output (FR-24.3).
 */

export const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'PUT', 'DELETE']);
export const MAX_REQUEST_BODY_BYTES = 1_048_576;
/** Longest wait honoured from a Retry-After header. */
const MAX_RETRY_AFTER_MS = 60 * 60_000;

/** `url` as given, or relative to the connection's base URL. */
export function resolveRequestUrl(raw: string, baseUrl?: string): URL {
  const value = raw.trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return new URL(value);
  if (!baseUrl) {
    throw new PermanentError(
      ErrorCategory.VALIDATION,
      'The URL must be absolute (https://…), or the HTTP connection must have a base URL',
    );
  }
  // "https://api.example.com/v1" + "items" → https://api.example.com/v1/items
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return new URL(value.replace(/^\/+/, ''), base);
}

export type HttpBody =
  | { type: 'none' }
  | { type: 'json'; value: unknown }
  | { type: 'text'; value: string }
  | { type: 'form'; value: Record<string, string> };

export function buildBody(body: HttpBody): { data?: Buffer; contentType?: string } {
  let data: Buffer | undefined;
  let contentType: string | undefined;
  switch (body.type) {
    case 'none':
      return {};
    case 'json':
      data = Buffer.from(JSON.stringify(body.value ?? null), 'utf8');
      contentType = 'application/json';
      break;
    case 'text':
      data = Buffer.from(String(body.value ?? ''), 'utf8');
      contentType = 'text/plain; charset=utf-8';
      break;
    case 'form':
      data = Buffer.from(new URLSearchParams(body.value ?? {}).toString(), 'utf8');
      contentType = 'application/x-www-form-urlencoded';
      break;
  }
  if (data.length > MAX_REQUEST_BODY_BYTES) {
    throw new PermanentError(ErrorCategory.VALIDATION, 'The request body exceeds 1 MB');
  }
  return { data, contentType };
}

/** Seconds or an HTTP date → milliseconds (capped); undefined when absent or invalid. */
export function parseRetryAfter(value: string | undefined, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  const ms = Number.isFinite(seconds) ? seconds * 1_000 : Date.parse(value) - now;
  if (!Number.isFinite(ms) || ms < 0) return undefined;
  return Math.min(ms, MAX_RETRY_AFTER_MS);
}

/** Transport failures → execution errors. `idempotent`: safe to send again. */
export function classifyTransportError(err: unknown, idempotent: boolean): ExecutionError {
  if (err instanceof ExecutionError) return err;
  if (err instanceof EgressBlockedError) {
    return new PermanentError(ErrorCategory.VALIDATION, err.message);
  }
  if (err instanceof EgressTimeoutError) {
    return err.sent && !idempotent
      ? new PermanentError(
          ErrorCategory.UNCERTAIN_OUTCOME,
          'The request timed out after it was sent; the server may or may not have processed it',
        )
      : new RetryableError(ErrorCategory.PROVIDER_TIMEOUT, 'The request timed out');
  }
  if (err instanceof EgressNetworkError) {
    if (isPermanentDnsError(err)) {
      return new PermanentError(ErrorCategory.PERMANENT_PROVIDER_ERROR, 'Host not found (DNS)');
    }
    if (err.sent && !idempotent) {
      return new PermanentError(
        ErrorCategory.UNCERTAIN_OUTCOME,
        `The connection failed after the request was sent (${err.code}); the outcome is unknown`,
      );
    }
    return new RetryableError(
      ErrorCategory.TRANSIENT_INFRASTRUCTURE,
      `The request could not be completed (${err.code})`,
    );
  }
  return new PermanentError(ErrorCategory.INTERNAL, 'Internal error');
}

/**
 * HTTP statuses → execution errors (null: the response is the step's output).
 * - 429 and 503: the server says it did not process the request → retry, honour Retry-After;
 * - other 5xx: retried for idempotent requests; for POST/PATCH the server received the request
 *   and its outcome is unknown → UNCERTAIN_OUTCOME (retried only on a human decision);
 * - 401/403: PROVIDER_AUTH; other 4xx: PERMANENT_PROVIDER_ERROR, unless `failOn4xx` is off.
 */
export function classifyStatus(
  res: Pick<EgressResponse, 'status' | 'statusText' | 'headers'>,
  options: { idempotent: boolean; failOn4xx: boolean },
): ExecutionError | null {
  const { status } = res;
  const label = `HTTP ${status}${res.statusText ? ` ${res.statusText}` : ''}`;
  if (status < 400) return null;
  if (status < 500) {
    if (!options.failOn4xx) return null;
    if (status === 429) {
      return new RetryableError(
        ErrorCategory.PROVIDER_RATE_LIMIT,
        `${label}: rate limited`,
        parseRetryAfter(res.headers['retry-after']),
      );
    }
    if (status === 401 || status === 403) {
      return new PermanentError(ErrorCategory.PROVIDER_AUTH, `${label}: check the HTTP connection`);
    }
    return new PermanentError(ErrorCategory.PERMANENT_PROVIDER_ERROR, label);
  }
  if (status === 503) {
    return new RetryableError(
      ErrorCategory.TRANSIENT_INFRASTRUCTURE,
      label,
      parseRetryAfter(res.headers['retry-after']),
    );
  }
  if (!options.idempotent) {
    return new PermanentError(
      ErrorCategory.UNCERTAIN_OUTCOME,
      `${label} after the request was sent; the server may have processed it`,
    );
  }
  return new RetryableError(ErrorCategory.TRANSIENT_INFRASTRUCTURE, label);
}

/** Response headers never copied into step output. */
const DROPPED_RESPONSE_HEADERS = new Set([
  'set-cookie',
  'set-cookie2',
  'authorization',
  'proxy-authenticate',
  'proxy-authorization',
  'cookie',
]);
const MAX_OUTPUT_HEADERS = 50;
const MAX_HEADER_VALUE = 1_024;

export interface HttpOutput {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: unknown;
  bodyTruncated?: true;
  durationMs: number;
  finalUrl: string;
}

export interface NormalizeOptions {
  responseType: 'auto' | 'json' | 'text';
  method: string;
  /** Largest body (as JSON) kept in the output. */
  maxStoredBodyBytes: number;
  onLargeResponse: 'truncate' | 'error';
  /** Credential header names (also dropped from the response, e.g. echoed API keys). */
  sensitiveHeaders: string[];
  secretParam?: string;
}

export function normalizeResponse(res: EgressResponse, options: NormalizeOptions): HttpOutput {
  const drop = new Set([...DROPPED_RESPONSE_HEADERS, ...options.sensitiveHeaders]);
  const headers = Object.fromEntries(
    Object.entries(res.headers)
      .filter(([name]) => !drop.has(name))
      .slice(0, MAX_OUTPUT_HEADERS)
      .map(([name, value]) => [name, value.slice(0, MAX_HEADER_VALUE)]),
  );

  const finalUrl = new URL(res.finalUrl);
  finalUrl.username = '';
  finalUrl.password = '';
  if (options.secretParam) finalUrl.searchParams.delete(options.secretParam);

  const tooLarge = (what: string) =>
    new PermanentError(
      ErrorCategory.PERMANENT_PROVIDER_ERROR,
      `RESPONSE_TOO_LARGE: the response ${what}`,
    );
  const text = res.body.toString('utf8');
  let body: unknown = null;
  let truncated = res.truncated;
  if (options.method !== 'HEAD' && res.body.length > 0) {
    const isJson =
      options.responseType === 'json' ||
      (options.responseType === 'auto' && /[/+]json\b/i.test(res.headers['content-type'] ?? ''));
    if (isJson && !truncated) {
      try {
        body = JSON.parse(text);
      } catch {
        if (options.responseType === 'json') {
          throw new PermanentError(
            ErrorCategory.PERMANENT_PROVIDER_ERROR,
            'The response is not valid JSON',
          );
        }
        body = text;
      }
    } else {
      if (truncated && options.onLargeResponse === 'error') throw tooLarge('is too large');
      if (truncated && options.responseType === 'json') throw tooLarge('is too large to parse');
      body = text;
    }
  }

  // What is stored must fit the step output limit.
  if (Buffer.byteLength(JSON.stringify(body), 'utf8') > options.maxStoredBodyBytes) {
    if (options.onLargeResponse === 'error') throw tooLarge('is larger than the stored limit');
    const raw = typeof body === 'string' ? body : JSON.stringify(body);
    body = truncateUtf8(raw, options.maxStoredBodyBytes - 64);
    truncated = true;
  }

  return {
    status: res.status,
    statusText: res.statusText,
    headers,
    body,
    ...(truncated && { bodyTruncated: true as const }),
    durationMs: res.durationMs,
    finalUrl: finalUrl.toString(),
  };
}

/**
 * Replaces the connection's own secret values wherever they appear in the output (servers
 * echo requests: debug endpoints, error pages, `url` fields). Plain and URL-encoded forms.
 */
export function scrubSecrets<T>(value: T, secrets: string[]): T {
  const needles = [
    ...new Set(
      secrets
        .filter((s) => s.length >= 4)
        .flatMap((s) => [
          s,
          encodeURIComponent(s),
          new URLSearchParams({ x: s }).toString().slice(2),
        ]),
    ),
  ].sort((a, b) => b.length - a.length);
  if (!needles.length) return value;
  const scrub = (v: unknown): unknown => {
    if (typeof v === 'string')
      return needles.reduce((text, n) => text.split(n).join('[REDACTED]'), v);
    if (Array.isArray(v)) return v.map(scrub);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [scrub(k) as string, scrub(x)]));
    }
    return v;
  };
  return scrub(value) as T;
}

function truncateUtf8(value: string, maxBytes: number): string {
  const buf = Buffer.from(value, 'utf8');
  if (buf.length <= maxBytes) return value;
  // Drop a partial multi-byte character at the cut.
  return buf.subarray(0, maxBytes).toString('utf8').replace(/�$/, '');
}
