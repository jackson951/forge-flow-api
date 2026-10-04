import { z } from 'zod';

/**
 * HTTP connections (Part 24, FR-24.4): how a connection authenticates requests. Pure — shared
 * by the API (create / rotate / test) and the worker (http.request). Secrets are split from
 * the non-secret settings: secrets are sealed in IntegrationCredential.encryptedPayload, the
 * rest lives in IntegrationConnection.metadata and may be shown to users.
 */

export const HTTP_AUTH_TYPES = [
  'bearer',
  'basic',
  'apiKeyHeader',
  'apiKeyQuery',
  'customHeaders',
] as const;
export type HttpAuthType = (typeof HTTP_AUTH_TYPES)[number];

/** RFC 9110 token characters. */
export const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,100}$/;
/** No CR/LF/NUL (header injection) and printable; at most 8 KB. */
const headerValue = z
  .string()
  .min(1)
  .max(8_192)
  .refine((v) => !/[\r\n\0]/.test(v), 'must not contain line breaks');
const secret = headerValue;

/**
 * Header names a workflow or connection may never set: connection management (hop-by-hop),
 * framing (smuggling) and values the client sets itself.
 */
export const RESERVED_HEADERS = new Set([
  'host',
  'connection',
  'keep-alive',
  'proxy-connection',
  'proxy-authorization',
  'proxy-authenticate',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'content-length',
  'expect',
  'accept-encoding',
]);

const headerName = z
  .string()
  .regex(HEADER_NAME, 'must be a valid HTTP header name')
  .refine((n) => !RESERVED_HEADERS.has(n.toLowerCase()), 'this header cannot be set');

export const httpCredentialsSchema = z.discriminatedUnion('authType', [
  z.object({ authType: z.literal('bearer'), token: secret }).strict(),
  z
    .object({
      authType: z.literal('basic'),
      username: z
        .string()
        .min(1)
        .max(256)
        .refine(
          (v) => !v.includes(':') && !/[\r\n\0]/.test(v),
          'must not contain ":" or line breaks',
        ),
      password: secret,
    })
    .strict(),
  z.object({ authType: z.literal('apiKeyHeader'), headerName, value: secret }).strict(),
  z
    .object({
      authType: z.literal('apiKeyQuery'),
      paramName: z.string().regex(/^[A-Za-z0-9_.\-[\]]{1,100}$/, 'must be a simple parameter name'),
      value: secret,
    })
    .strict(),
  z
    .object({
      authType: z.literal('customHeaders'),
      headers: z
        .record(headerName, secret)
        .refine((h) => Object.keys(h).length >= 1 && Object.keys(h).length <= 10, '1 to 10 headers')
        .refine(
          (h) => new Set(Object.keys(h).map((k) => k.toLowerCase())).size === Object.keys(h).length,
          'header names must be unique',
        ),
    })
    .strict(),
]);
export type HttpCredentials = z.infer<typeof httpCredentialsSchema>;

/** Non-secret auth settings kept in the connection metadata. */
export interface HttpAuthMetadata {
  authType: HttpAuthType;
  headerName?: string;
  paramName?: string;
  headerNames?: string[];
  /** Last characters of the main secret, e.g. "…a1b2" (never more than 4). */
  secretHint: string;
}

export interface HttpConnectionMetadata extends HttpAuthMetadata {
  baseUrl?: string;
  allowedHosts?: string[];
}

const hint = (value: string) => (value.length >= 12 ? `…${value.slice(-4)}` : '…');

/** Splits validated credentials into sealed secrets and visible metadata. */
export function splitCredentials(credentials: HttpCredentials): {
  secrets: Record<string, string>;
  metadata: HttpAuthMetadata;
} {
  switch (credentials.authType) {
    case 'bearer':
      return {
        secrets: { token: credentials.token },
        metadata: { authType: 'bearer', secretHint: hint(credentials.token) },
      };
    case 'basic':
      return {
        secrets: { username: credentials.username, password: credentials.password },
        metadata: { authType: 'basic', secretHint: hint(credentials.password) },
      };
    case 'apiKeyHeader':
      return {
        secrets: { value: credentials.value },
        metadata: {
          authType: 'apiKeyHeader',
          headerName: credentials.headerName,
          secretHint: hint(credentials.value),
        },
      };
    case 'apiKeyQuery':
      return {
        secrets: { value: credentials.value },
        metadata: {
          authType: 'apiKeyQuery',
          paramName: credentials.paramName,
          secretHint: hint(credentials.value),
        },
      };
    case 'customHeaders': {
      const names = Object.keys(credentials.headers);
      return {
        secrets: Object.fromEntries(names.map((n) => [`header:${n}`, credentials.headers[n]])),
        metadata: { authType: 'customHeaders', headerNames: names, secretHint: '…' },
      };
    }
  }
}

export interface AppliedAuth {
  url: URL;
  headers: Record<string, string>;
  /** Header names carrying credentials: stripped on cross-origin redirects, never logged. */
  sensitiveHeaders: string[];
  /** Query parameter carrying a credential: removed from `finalUrl` in step output. */
  secretParam?: string;
}

/** Adds the connection's credentials to a request (headers lower-cased). */
export function applyAuth(
  metadata: HttpAuthMetadata,
  secrets: Record<string, string>,
  url: URL,
  headers: Record<string, string>,
): AppliedAuth {
  const out = { ...headers };
  const authUrl = new URL(url);
  switch (metadata.authType) {
    case 'bearer':
      out.authorization = `Bearer ${secrets.token}`;
      return { url: authUrl, headers: out, sensitiveHeaders: ['authorization'] };
    case 'basic':
      out.authorization = `Basic ${Buffer.from(`${secrets.username}:${secrets.password}`).toString('base64')}`;
      return { url: authUrl, headers: out, sensitiveHeaders: ['authorization'] };
    case 'apiKeyHeader': {
      const name = metadata.headerName!.toLowerCase();
      out[name] = secrets.value;
      return { url: authUrl, headers: out, sensitiveHeaders: [name] };
    }
    case 'apiKeyQuery':
      authUrl.searchParams.set(metadata.paramName!, secrets.value);
      return { url: authUrl, headers: out, sensitiveHeaders: [], secretParam: metadata.paramName };
    case 'customHeaders': {
      const names = (metadata.headerNames ?? []).map((n) => n.toLowerCase());
      for (const name of metadata.headerNames ?? [])
        out[name.toLowerCase()] = secrets[`header:${name}`];
      return { url: authUrl, headers: out, sensitiveHeaders: names };
    }
  }
}

/** Host patterns for a connection's allow-list: "api.example.com" or "*.example.com". */
export const allowedHostSchema = z
  .string()
  .max(253)
  .regex(
    /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i,
    'use a host name such as api.example.com or *.example.com',
  )
  .transform((h) => h.toLowerCase());
