import { NestExpressApplication } from '@nestjs/platform-express';
import { TestingModule } from '@nestjs/testing';
import { RunStatus, StepRun } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { BUILT_IN_NODE_TYPES, NodeTypeCatalog } from '../../src/engine/catalog/node-type-catalog';
import { PrismaService } from '../../src/infrastructure/prisma/prisma.service';
import { RunQueue } from '../../src/infrastructure/queue/run-queue.service';
import { aiNodeTypes } from '../../src/modules/ai/ai.node-types';
import { GITHUB_NODE_TYPES } from '../../src/modules/integrations/github/github.node-types';
import { bearer, registerUser, RegisteredUser } from '../support/auth';
import { captureLogs } from '../support/canaries';
import { createTestApp } from '../support/create-app';
import { createTestWorker, waitFor } from '../support/create-worker';
import { truncateAll } from '../support/test-database';
import { TestNodeControl } from '../support/test-node-types';

const AI_KEY_CANARY = process.env.AI_API_KEY!;
const ISSUE_BODY = 'Clicking save throws a stack trace: this is a bug in the editor';

const trigger = { key: 'trigger', kind: 'TRIGGER', type: 'manual.trigger', config: {} };
const log = (key: string, message: string) => ({
  key,
  kind: 'ACTION',
  type: 'util.log',
  config: { message },
});

/** issue → classify → branch on label → log. The flagship flow with the fake model. */
const triageFlow = {
  schemaVersion: 1,
  nodes: [
    trigger,
    {
      key: 'classify',
      kind: 'ACTION',
      type: 'ai.classify',
      config: {
        text: '{{ trigger.title }}\n{{ trigger.body }}',
        labels: ['bug', 'feature', 'question'],
        field: 'issue type',
      },
    },
    {
      key: 'is_bug',
      kind: 'CONDITION',
      type: 'condition',
      config: {
        all: [
          {
            left: { ref: 'steps.classify.output.label' },
            operator: 'equals',
            right: { value: 'bug' },
          },
        ],
      },
    },
    log('notify_bug', 'Bug ({{ steps.classify.output.label }}): {{ trigger.title }}'),
    log('notify_other', 'Not a bug'),
  ],
  edges: [
    { from: 'trigger', to: 'classify' },
    { from: 'classify', to: 'is_bug' },
    { from: 'is_bug', to: 'notify_bug', branch: 'true' },
    { from: 'is_bug', to: 'notify_other', branch: 'false' },
  ],
};

const extractFlow = {
  schemaVersion: 1,
  nodes: [
    trigger,
    {
      key: 'extract',
      kind: 'ACTION',
      type: 'ai.extract',
      config: {
        text: '{{ trigger.body }}',
        fields: [
          { name: 'version', type: 'string' },
          { name: 'affectedUsers', type: 'number' },
          { name: 'area', type: 'enum', enumValues: ['api', 'ui'] },
          { name: 'regression', type: 'boolean', required: false },
        ],
      },
    },
    {
      key: 'summary',
      kind: 'ACTION',
      type: 'ai.summarize',
      config: { text: '{{ trigger.body }}', maxWords: 20 },
    },
    log(
      'report',
      'v{{ steps.extract.output.version }} in {{ steps.extract.output.area }}: {{ steps.summary.output.summary }}',
    ),
  ],
  edges: [
    { from: 'trigger', to: 'extract' },
    { from: 'extract', to: 'summary' },
    { from: 'summary', to: 'report' },
  ],
};

describe('AI steps (integration, fake provider)', () => {
  let api: NestExpressApplication;
  let server: App;
  let prisma: PrismaService;
  let worker: TestingModule;
  let user: RegisteredUser;
  let ws: string;
  const logged: unknown[][] = [];
  const responses: unknown[] = [];

  const auth = () => bearer(user.accessToken);
  const workflows = () => `/api/v1/workspaces/${ws}/workflows`;

  async function publish(
    definition: object,
    target: App = server,
  ): Promise<{ workflowId: string; res: request.Response }> {
    const wf = await request(target).post(workflows()).set(auth()).send({ name: 'ai' }).expect(201);
    const draft = await request(target)
      .put(`${workflows()}/${wf.body.id}/draft`)
      .set(auth())
      .send({ expectedRevision: 0, definition });
    responses.push(wf.body, draft.body);
    const res = await request(target)
      .post(`${workflows()}/${wf.body.id}/publish`)
      .set(auth())
      .send({ expectedRevision: 1 });
    return { workflowId: wf.body.id, res };
  }

  async function run(definition: object, input: object) {
    const published = await publish(definition);
    expect(published.res.status).toBe(201);
    responses.push(published.res.body);
    const started = await request(server)
      .post(`${workflows()}/${published.workflowId}/runs`)
      .set(auth())
      .send({ input })
      .expect(202);
    const done = await waitFor(
      async () => {
        const r = await prisma.workflowRun.findUniqueOrThrow({ where: { id: started.body.runId } });
        return (['SUCCEEDED', 'FAILED'] as RunStatus[]).includes(r.status) ? r : undefined;
      },
      { what: 'AI run to finish' },
    );
    const steps = await prisma.stepRun.findMany({ where: { runId: done.id } });
    return { run: done, steps: Object.fromEntries(steps.map((s: StepRun) => [s.nodeKey, s])) };
  }

  beforeAll(async () => {
    // Every structured log call made by the API and the worker during this suite.
    captureLogs(logged);
    api = await createTestApp();
    server = api.getHttpServer();
    prisma = api.get(PrismaService);
    await truncateAll(prisma);
    worker = await createTestWorker(new TestNodeControl());
    user = await registerUser(server);
    ws = (await prisma.workspaceMember.findFirstOrThrow({ where: { userId: user.id } }))
      .workspaceId;
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await worker?.close();
    await api.get(RunQueue).queue.obliterate({ force: true });
    await api.close();
  });

  it('lists the AI node types as available', async () => {
    const res = await request(server).get('/api/v1/node-types').set(auth()).expect(200);
    responses.push(res.body);
    expect(res.body).toEqual(
      expect.arrayContaining(
        ['ai.summarize', 'ai.classify', 'ai.extract'].map((type) =>
          expect.objectContaining({ type, kind: 'ACTION', available: true }),
        ),
      ),
    );
  });

  it('classifies through the worker and branches on the validated label (AC-12.1)', async () => {
    const { run: done, steps } = await run(triageFlow, { title: 'Editor crash', body: ISSUE_BODY });

    expect(done.status).toBe('SUCCEEDED');
    expect(steps.classify.status).toBe('SUCCEEDED');
    expect(steps.classify.sanitizedOutput).toEqual({
      label: 'bug',
      confidence: 0.9,
      usage: { inputTokens: expect.any(Number), outputTokens: expect.any(Number), model: 'fake' },
      meta: {
        attempts: 1,
        inputChars: ISSUE_BODY.length + 'Editor crash\n'.length,
        truncated: false,
      },
    });
    expect(steps.is_bug.sanitizedOutput).toEqual({ result: true });
    expect(steps.notify_bug.sanitizedOutput).toEqual({ message: 'Bug (bug): Editor crash' });
    expect(steps.notify_other.status).toBe('SKIPPED');
  });

  it('takes the other branch for a different label', async () => {
    const { steps } = await run(triageFlow, {
      title: 'Idea',
      body: 'A feature request: dark mode',
    });
    expect(steps.classify.sanitizedOutput).toMatchObject({ label: 'feature' });
    expect(steps.notify_bug.status).toBe('SKIPPED');
    expect(steps.notify_other.status).toBe('SUCCEEDED');
  });

  it('extracts schema-validated fields and summarises, feeding later steps', async () => {
    const body =
      'version: 2.4.1\naffectedUsers: 120\nThe UI export dialog freezes after upgrading.';
    const { run: done, steps } = await run(extractFlow, { body });

    expect(done.status).toBe('SUCCEEDED');
    expect(steps.extract.sanitizedOutput).toMatchObject({
      version: '2.4.1',
      affectedUsers: 120,
      area: 'ui',
      regression: null,
    });
    expect(steps.summary.sanitizedOutput).toMatchObject({ summary: expect.any(String) });
    expect(steps.report.sanitizedOutput).toEqual({
      message: expect.stringMatching(/^v2\.4\.1 in ui: version: 2\.4\.1/),
    });
  });

  describe('long input', () => {
    const body = 'bug '.repeat(6_000); // 24 000 chars, above AI_MAX_INPUT_CHARS (20 000)
    const withText = (text: unknown) => ({
      ...triageFlow,
      nodes: triageFlow.nodes.map((n) =>
        n.key === 'classify' ? { ...n, config: { ...n.config, text } } : n,
      ),
    });

    it('takes the raw value through { ref }, truncates it and records that (FR-12.5)', async () => {
      const { steps } = await run(withText({ ref: 'trigger.body' }), { body });
      expect([steps.classify.status, steps.classify.errorMessage]).toEqual(['SUCCEEDED', null]);
      expect(steps.classify.sanitizedOutput).toMatchObject({
        label: 'bug',
        meta: { truncated: true, inputChars: 24_000 },
      });
    });

    it('fails a template rendering above the 16 KB template cap with a clear message', async () => {
      const { run: done, steps } = await run(withText('{{ trigger.body }}'), { body });
      expect(done.status).toBe('FAILED');
      expect(steps.classify).toMatchObject({
        status: 'FAILED',
        errorCategory: 'VALIDATION',
        errorMessage: 'Rendered text exceeds 16 KB',
      });
    });
  });

  it('never exposes the API key in responses or logs, and logs no prompt or output content (AC-12.5)', async () => {
    expect(logged.length).toBeGreaterThan(0);
    const logs = JSON.stringify(logged);
    expect(logs).toContain('AI step completed');
    expect(logs).not.toContain(AI_KEY_CANARY);
    expect(logs).not.toContain('stack trace: this is a bug');
    expect(logs).not.toContain('dark mode');
    expect(logs).not.toContain('export dialog freezes');

    expect(responses.length).toBeGreaterThan(5);
    expect(JSON.stringify(responses)).not.toContain(AI_KEY_CANARY);
    const stored = await prisma.stepRun.findMany({
      select: { sanitizedOutput: true, errorMessage: true },
    });
    expect(JSON.stringify(stored)).not.toContain(AI_KEY_CANARY);
  });

  describe('without a configured provider', () => {
    let disabled: NestExpressApplication;

    beforeAll(async () => {
      disabled = await createTestApp((b) =>
        b.overrideProvider(NodeTypeCatalog).useFactory({
          factory: () =>
            new NodeTypeCatalog([
              ...BUILT_IN_NODE_TYPES,
              ...GITHUB_NODE_TYPES,
              ...aiNodeTypes(false),
            ]),
        }),
      );
    });
    afterAll(() => disabled.close());

    it('saves the draft with PROVIDER_NOT_CONFIGURED and refuses to publish it', async () => {
      const target = disabled.getHttpServer();
      const { res } = await publish(triageFlow, target);
      expect(res.status).toBe(422);
      expect(res.body.details).toEqual([
        expect.objectContaining({ code: 'PROVIDER_NOT_CONFIGURED', nodeKey: 'classify' }),
      ]);
      const types = await request(target).get('/api/v1/node-types').set(auth()).expect(200);
      expect(types.body).toContainEqual(
        expect.objectContaining({ type: 'ai.classify', available: false }),
      );
    });
  });
});
