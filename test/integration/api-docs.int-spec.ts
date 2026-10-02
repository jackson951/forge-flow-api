import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { createTestApp } from '../support/create-app';

type Operation = {
  operationId: string;
  summary?: string;
  security?: unknown[];
  responses: Record<string, { content?: Record<string, { schema?: { $ref?: string } }> }>;
};

/**
 * Part 22 — API documentation review, kept true: every operation in the served OpenAPI
 * document has a summary and documents its error responses with the shared envelope.
 */
describe('API documentation (integration, Part 22)', () => {
  let app: NestExpressApplication;
  let operations: [string, Operation][];
  let doc: { components: { schemas: Record<string, unknown> } };

  beforeAll(async () => {
    app = await createTestApp();
    const res = await request(app.getHttpServer()).get('/api/docs-json').expect(200);
    doc = res.body;
    operations = Object.entries(
      res.body.paths as Record<string, Record<string, Operation>>,
    ).flatMap(([path, item]) =>
      Object.entries(item).map(
        ([verb, op]) => [`${verb.toUpperCase()} ${path}`, op] as [string, Operation],
      ),
    );
  });

  afterAll(() => app.close());

  it('documents every operation with a summary', () => {
    expect(operations.length).toBeGreaterThanOrEqual(47);
    expect(operations.filter(([, op]) => !op.summary).map(([id]) => id)).toEqual([]);
  });

  it('documents error responses with the shared ErrorResponse envelope', () => {
    expect(doc.components.schemas.ErrorResponse).toBeDefined();
    const missing = operations.flatMap(([id, op]) => {
      const problems: string[] = [];
      for (const code of ['429', '500']) if (!op.responses[code]) problems.push(`${id} ${code}`);
      if (op.security?.length && !op.responses['401']) problems.push(`${id} 401`);
      if (id.includes('{') && !op.responses['404']) problems.push(`${id} 404`);
      return problems;
    });
    expect(missing).toEqual([]);
    const notFound = operations.find(([id]) =>
      id.startsWith('GET /api/v1/workspaces/{workspaceId}/runs/{id}'),
    )!;
    expect(notFound[1].responses['404'].content?.['application/json']?.schema?.$ref).toBe(
      '#/components/schemas/ErrorResponse',
    );
  });

  it('every workspace route requires a bearer token in the document', () => {
    const open = operations
      .filter(([id]) => id.includes('/workspaces'))
      .filter(([, op]) => !op.security?.length)
      .map(([id]) => id);
    expect(open).toEqual([]);
  });
});
