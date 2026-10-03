import { ErrorCategory, IntegrationProviderKey } from '@prisma/client';
import { z } from 'zod';
import { NodeTypeDefinition } from '../../../engine/catalog/node-type-catalog';
import { ExecutionError, PermanentError } from '../../../engine/errors';
import { NodeHandler } from '../../../engine/execution/node-handler';
import { EgressClient } from '../../../infrastructure/egress/egress-client';
import {
  checkUrl,
  describeUrl,
  EgressBlockedError,
  EgressPolicy,
  hostAllowed,
} from '../../../infrastructure/egress/egress-policy';
import { applyAuth, HEADER_NAME, HttpConnectionMetadata, RESERVED_HEADERS } from './http-auth';
import {
  buildBody,
  classifyStatus,
  classifyTransportError,
  HttpBody,
  IDEMPOTENT_METHODS,
  normalizeResponse,
  resolveRequestUrl,
  scrubSecrets,
} from './http-request';

export const HTTP_REQUEST = 'http.request';

/** Header names that carry credentials: they belong in an HTTP connection (FR-24.2). */
const CREDENTIAL_HEADERS =
  /^(authorization|proxy-authorization|cookie|x-api-key|api-key|apikey|x-auth-token|x-access-token|private-token)$/i;

const templated = (value: string) => value.includes('{{');

const headerName = z
  .string()
  .regex(HEADER_NAME, 'must be a valid HTTP header name')
  .refine(
    (n) => CREDENTIAL_HEADERS.test(n) || !RESERVED_HEADERS.has(n.toLowerCase()),
    'this header is set by FlowForge',
  )
  .refine(
    (n) => !CREDENTIAL_HEADERS.test(n),
    'credentials must not be stored in the workflow; use an HTTP connection',
  );
const headerValue = z
  .string()
  .max(8_192)
  .refine((v) => !/[\r\n\0]/.test(v), 'must not contain line breaks');
type StringSchema = z.ZodType<string, z.ZodTypeDef, string>;
const limitedRecord = (key: StringSchema, value: StringSchema, max: number) =>
  z
    .record(key, value)
    .refine((r) => Object.keys(r).length <= max, `at most ${max} entries`)
    .default({} as Record<string, string>);

const bodySchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }).strict(),
  z.object({ type: z.literal('json'), value: z.unknown() }).strict(),
  z.object({ type: z.literal('text'), value: z.string().max(65_536) }).strict(),
  z
    .object({
      type: z.literal('form'),
      value: limitedRecord(z.string().min(1).max(200), z.string().max(8_192), 100),
    })
    .strict(),
]);

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'] as const;

/** FR-24.1. Templates are allowed in url, query, header values and body. */
export function httpRequestConfigSchema(policy: EgressPolicy) {
  return z
    .object({
      method: z.enum(METHODS).default('GET'),
      url: z.string().trim().min(1).max(2_048),
      query: limitedRecord(z.string().min(1).max(200), z.string().max(2_048), 50),
      headers: limitedRecord(headerName, headerValue, 50),
      body: bodySchema.default({ type: 'none' }),
      timeoutMs: z.number().int().min(1_000).max(30_000).default(10_000),
      connectionId: z.string().uuid().optional(),
      followRedirects: z.boolean().default(true),
      responseType: z.enum(['auto', 'json', 'text']).default('auto'),
      /** Off: 4xx responses become the step output instead of failing the step. */
      failOn4xx: z.boolean().default(true),
      /**
       * POST/PATCH only: the target API de-duplicates (e.g. honours Idempotency-Key), so the
       * request may be retried automatically. FlowForge then sends a stable Idempotency-Key.
       */
      idempotent: z.boolean().default(false),
      onLargeResponse: z.enum(['truncate', 'error']).default('truncate'),
    })
    .strict()
    .superRefine((config, ctx) => {
      if ((config.method === 'GET' || config.method === 'HEAD') && config.body.type !== 'none') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['body'],
          message: `${config.method} requests cannot have a body`,
        });
      }
      // A static absolute URL is checked now; templated or relative ones at run time.
      if (!templated(config.url) && /^[a-z][a-z0-9+.-]*:/i.test(config.url)) {
        try {
          checkUrl(config.url, policy);
        } catch (err) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['url'],
            message:
              err instanceof EgressBlockedError ? err.message : 'URL must be a valid absolute URL',
          });
        }
      } else if (!templated(config.url) && !config.connectionId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['url'],
          message: 'Use an absolute URL (https://…), or a connection with a base URL',
        });
      }
    });
}

type HttpRequestConfig = z.infer<ReturnType<typeof httpRequestConfigSchema>>;

export function httpNodeTypes(policy: EgressPolicy, enabled: boolean): NodeTypeDefinition[] {
  return [
    {
      type: HTTP_REQUEST,
      kind: 'ACTION',
      displayName: 'HTTP request',
      configSchema: httpRequestConfigSchema(policy),
      connectionProvider: IntegrationProviderKey.HTTP,
      connectionOptional: true,
      ...(!enabled && { unavailableReason: 'HTTP requests are disabled on this server' }),
    },
  ];
}

/** What the HTTP handler may do with connections (worker side, workspace-scoped). */
export interface HttpConnectionAccess {
  httpConnection(
    workspaceId: string,
    connectionId: string,
  ): Promise<{ metadata: HttpConnectionMetadata; secrets: Record<string, string> }>;
}

export interface HttpHandlerSettings {
  policy: EgressPolicy;
  maxResponseBytes: number;
  maxStoredBodyBytes: number;
}

/**
 * `http.request` (worker). Declared non-idempotent: a step found RUNNING after a crash is
 * never repeated automatically (it may have been a POST). Retries of failed attempts follow
 * the method: GET/HEAD/PUT/DELETE (and POST/PATCH marked `idempotent`) are retried on
 * transient failures; for other requests an unknown outcome is UNCERTAIN_OUTCOME.
 */
export function createHttpHandlers(
  egress: EgressClient,
  connections: HttpConnectionAccess,
  settings: HttpHandlerSettings,
): NodeHandler[] {
  const handler: NodeHandler = {
    type: HTTP_REQUEST,
    kind: 'ACTION',
    sideEffect: 'non-idempotent',
    async execute({ workspaceId, config: raw, idempotencyKey, signal, logger }) {
      const parsed = httpRequestConfigSchema(settings.policy).safeParse(raw);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new PermanentError(
          ErrorCategory.VALIDATION,
          `Invalid HTTP request configuration: ${issue.path.join('.') || 'config'} ${issue.message}`,
        );
      }
      const config: HttpRequestConfig = parsed.data;
      const idempotent = IDEMPOTENT_METHODS.has(config.method) || config.idempotent;

      const connection = config.connectionId
        ? await connections.httpConnection(workspaceId, config.connectionId)
        : undefined;
      const meta = connection?.metadata;

      let url: URL;
      try {
        url = resolveRequestUrl(config.url, meta?.baseUrl);
      } catch (err) {
        if (err instanceof ExecutionError) throw err;
        throw new PermanentError(ErrorCategory.VALIDATION, 'The rendered URL is not a valid URL');
      }
      for (const [key, value] of Object.entries(config.query)) url.searchParams.append(key, value);

      const body = buildBody(config.body as HttpBody);
      let headers: Record<string, string> = Object.fromEntries(
        Object.entries(config.headers).map(([k, v]) => [k.toLowerCase(), v]),
      );
      if (Object.values(headers).some((v) => /[\r\n\0]/.test(v))) {
        throw new PermanentError(
          ErrorCategory.VALIDATION,
          'A rendered header value contains a line break',
        );
      }
      if (body.contentType && !headers['content-type']) headers['content-type'] = body.contentType;
      headers['user-agent'] ??= 'FlowForge/1.0';
      if (config.idempotent && !IDEMPOTENT_METHODS.has(config.method)) {
        headers['idempotency-key'] ??= idempotencyKey;
      }

      let sensitiveHeaders: string[] = [];
      let secretParam: string | undefined;
      if (connection && meta) {
        const applied = applyAuth(meta, connection.secrets, url, headers);
        url = applied.url;
        headers = applied.headers;
        sensitiveHeaders = applied.sensitiveHeaders;
        secretParam = applied.secretParam;
      }
      const checkHop = (hop: URL) => {
        // Credentials only ever go to the connection's allowed hosts (exfiltration guard).
        if (meta && !hostAllowed(hop.hostname.replace(/^\[|\]$/g, ''), meta.allowedHosts)) {
          throw new EgressBlockedError("host is not in the connection's allowed hosts");
        }
      };

      // Logs: scheme, host, path and query keys only — never values or the credential param.
      const logged = new URL(url);
      if (secretParam) logged.searchParams.delete(secretParam);
      const target = describeUrl(logged);
      let response;
      try {
        response = await egress.send({
          method: config.method,
          url: url.toString(),
          headers,
          body: body.data,
          timeoutMs: config.timeoutMs,
          maxRedirects: config.followRedirects ? 3 : 0,
          maxResponseBytes: settings.maxResponseBytes,
          signal,
          checkHop,
          sensitiveHeaders,
        });
      } catch (err) {
        const classified = classifyTransportError(err, idempotent);
        const blocked = err instanceof EgressBlockedError;
        logger.warn('HTTP request failed', {
          method: config.method,
          url: target,
          category: classified.category,
          ...(blocked && { egressBlocked: true }),
        });
        throw classified;
      }

      logger.info('HTTP request completed', {
        method: config.method,
        url: target,
        status: response.status,
        durationMs: response.durationMs,
        requestBytes: body.data?.length ?? 0,
        responseBytes: response.body.length,
        redirects: response.redirects,
      });
      const failure = classifyStatus(response, { idempotent, failOn4xx: config.failOn4xx });
      if (failure) throw failure;
      const output = normalizeResponse(response, {
        responseType: config.responseType,
        method: config.method,
        maxStoredBodyBytes: settings.maxStoredBodyBytes,
        onLargeResponse: config.onLargeResponse,
        sensitiveHeaders,
        secretParam,
      });
      return { output: scrubSecrets(output, Object.values(connection?.secrets ?? {})) };
    },
  };
  return [handler];
}
