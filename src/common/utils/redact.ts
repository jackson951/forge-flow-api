/** Paths that must never appear in logs. Fed to the logger's redaction config. */
export const REDACTED_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-hub-signature-256"]',
  'req.headers["x-slack-signature"]',
  'req.headers["x-flowforge-signature"]',
  'req.headers["set-cookie"]',
  'res.headers["set-cookie"]',
  '*.token',
  '*.secret',
  '*.authorization',
  '*.password',
  '*.accessToken',
  '*.refreshToken',
  '*.clientSecret',
];

/**
 * Query parameters that carry credentials or one-time secrets (OAuth `code` and `state`,
 * tokens in links). Their values are replaced in logged request URLs and query objects.
 */
const SENSITIVE_QUERY_KEY =
  /^(code|state|token|access_token|refresh_token|id_token|client_secret|secret|password|signature|sig|api_key|apikey|key)$/i;

export function redactQueryString(url: string): string {
  const start = url.indexOf('?');
  if (start < 0) return url;
  const query = url
    .slice(start + 1)
    .split('&')
    .map((pair) => {
      const [key] = pair.split('=', 1);
      return SENSITIVE_QUERY_KEY.test(decodeURIComponentSafe(key)) ? `${key}=[REDACTED]` : pair;
    })
    .join('&');
  return `${url.slice(0, start + 1)}${query}`;
}

export function redactQuery(query: unknown): unknown {
  if (!query || typeof query !== 'object') return query;
  return Object.fromEntries(
    Object.entries(query).map(([k, v]) => [k, SENSITIVE_QUERY_KEY.test(k) ? '[REDACTED]' : v]),
  );
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
