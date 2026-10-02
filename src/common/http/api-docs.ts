import { OpenAPIObject } from '@nestjs/swagger';

type Operation = {
  summary?: string;
  description?: string;
  parameters?: { in: string }[];
  requestBody?: unknown;
  security?: unknown[];
  responses: Record<string, unknown>;
};

/** The single error envelope written by AllExceptionsFilter. */
export const ERROR_RESPONSE_SCHEMA = {
  type: 'object',
  required: ['statusCode', 'error', 'message', 'requestId', 'path', 'timestamp'],
  properties: {
    statusCode: { type: 'integer', example: 404 },
    error: { type: 'string', example: 'Not Found' },
    message: {
      oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
      example: 'Workflow not found',
    },
    details: { description: 'Machine-readable context, e.g. { code: "UNCERTAIN_OUTCOME" }' },
    requestId: { type: 'string', example: '3f6c0f4e-0f7a-4c55-9a43-5c1f3a0b9e21' },
    path: { type: 'string', example: '/api/v1/workspaces/…/workflows/…' },
    timestamp: { type: 'string', format: 'date-time' },
  },
} as const;

const ref = (description: string) => ({
  description,
  content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
});

/**
 * Adds the error responses every operation can produce (Part 22, API documentation review),
 * so they are documented once and consistently rather than per controller:
 * 400 when the operation takes input, 401 when it needs a bearer token, 404 when the path
 * names a resource (non-members also get 404, never 403, so workspaces cannot be probed),
 * 429 (rate limits) and 500 everywhere. Responses a controller documents itself are kept.
 */
export function withStandardResponses(document: OpenAPIObject): OpenAPIObject {
  document.components ??= {};
  document.components.schemas ??= {};
  document.components.schemas.ErrorResponse = ERROR_RESPONSE_SCHEMA as never;

  for (const [path, item] of Object.entries(document.paths)) {
    for (const op of Object.values(item) as Operation[]) {
      if (!op?.responses) continue;
      // Handlers documented by JSDoc get it as `description`; Swagger UI lists `summary`.
      if (!op.summary && op.description) op.summary = op.description.split(/(?<=\.)\s|\n/)[0];
      const add = (code: string, description: string) => {
        op.responses[code] ??= ref(description);
      };
      const takesInput =
        op.requestBody !== undefined || (op.parameters ?? []).some((p) => p.in !== 'header');
      if (takesInput) add('400', 'Invalid input (validation errors listed in `message`)');
      if (op.security?.length) add('401', 'Missing, invalid or expired bearer token');
      if (path.includes('{')) {
        add('404', 'Not found — also returned when the caller is not a member of the workspace');
      }
      add('429', 'Rate limit exceeded; see the Retry-After header (seconds)');
      add('500', 'Unexpected error (details only in server logs, correlated by requestId)');
    }
  }
  return document;
}
