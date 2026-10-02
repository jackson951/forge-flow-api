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
