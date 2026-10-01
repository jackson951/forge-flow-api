import { Prisma, PrismaClient } from '@prisma/client';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  createRun,
  createUser,
  createVersion,
  createWorkflow,
  createWorkspace,
  sampleDefinition,
} from '../support/factories';
import { truncateAll } from '../support/test-database';
import { assertSeedAllowed, DEMO_EMAIL, seed } from '../../prisma/seed';

const prisma = new PrismaClient();

const uniqueViolation = { code: 'P2002' };
const foreignKeyViolation = { code: 'P2003' };

/** Builds workspace → workflow → version → run. */
async function graph() {
  const user = await createUser(prisma);
  const workspace = await createWorkspace(prisma, user.id);
  const workflow = await createWorkflow(prisma, workspace.id);
  const version = await createVersion(prisma, workflow, 1, user.id);
  const run = await createRun(prisma, version);
  return { user, workspace, workflow, version, run };
}

beforeEach(() => truncateAll(prisma));
afterAll(() => prisma.$disconnect());

describe('migrations (AC-02.1)', () => {
  it('applied every migration in the repository to the empty test database', async () => {
    const onDisk = readdirSync(join(__dirname, '../../prisma/migrations'), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    const applied = await prisma.$queryRaw<{ migration_name: string }[]>`
      SELECT migration_name FROM _prisma_migrations
      WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name`;
    expect(applied.map((m) => m.migration_name)).toEqual(onDisk);
  });
});

describe('indexes and unique constraints (AC-02.3)', () => {
  // Matched by table + ordered columns (not name: Postgres truncates names over 63 chars).
  it.each([
    ['User', ['email'], true],
    ['RefreshToken', ['tokenHash'], true],
    ['RefreshToken', ['familyId'], false],
    ['RefreshToken', ['userId'], false],
    ['WorkspaceMember', ['workspaceId', 'userId'], true],
    ['WorkspaceMember', ['userId'], false],
    ['Workflow', ['workspaceId', 'status', 'updatedAt'], false],
    ['Workflow', ['activeVersionId'], true],
    ['WorkflowVersion', ['workflowId', 'version'], true],
    ['WorkflowTrigger', ['provider', 'eventType', 'resourceKey'], false],
    ['WorkflowTrigger', ['workflowId'], true],
    ['WorkflowRun', ['workspaceId', 'idempotencyKey'], true],
    ['WorkflowRun', ['workspaceId', 'createdAt'], false],
    ['WorkflowRun', ['workspaceId', 'status', 'createdAt'], false],
    ['WorkflowRun', ['workflowId', 'createdAt'], false],
    ['WorkflowRun', ['status', 'queuedAt'], false],
    ['StepRun', ['runId', 'nodeKey'], true],
    ['StepRun', ['runId', 'sequence'], false],
    ['IntegrationConnection', ['workspaceId', 'provider', 'externalAccountId'], true],
    ['IntegrationCredential', ['connectionId'], true],
    ['OAuthState', ['stateHash'], true],
    ['WebhookDelivery', ['provider', 'deliveryId'], true],
    ['WebhookDelivery', ['receivedAt'], false],
    ['AuditEvent', ['workspaceId', 'createdAt'], false],
  ] as const)('%s(%s) unique=%s', async (table, columns, isUnique) => {
    const rows = await prisma.$queryRaw<{ columns: string[]; unique: boolean }[]>`
      SELECT array_agg(a.attname::text ORDER BY k.ord) AS columns, ix.indisunique AS unique
      FROM pg_index ix
      JOIN pg_class t ON t.oid = ix.indrelid
      CROSS JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY AS k(attnum, ord)
      JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
      WHERE t.relname = ${table}
      GROUP BY ix.indexrelid, ix.indisunique`;
    expect(rows).toContainEqual({ columns: [...columns], unique: isUnique });
  });
});

describe('workspace ownership (AC-02.4)', () => {
  // Models without their own workspaceId, and why that is safe.
  const exempt: Record<string, string> = {
    User: 'global identity',
    RefreshToken: 'belongs to a user, not a workspace',
    Workspace: 'is the tenant',
    StepRun: 'immutable parent WorkflowRun has workspaceId',
    IntegrationCredential: 'immutable parent IntegrationConnection has workspaceId',
  };
  // Models whose workspaceId is deliberately nullable.
  const nullable: Record<string, string> = {
    WebhookDelivery: 'stored before routing; may match no workspace',
    AuditEvent: 'account-level events have no workspace',
  };

  it.each(Prisma.dmmf.datamodel.models.map((m) => [m.name, m] as const))(
    '%s is workspace-scoped or explicitly exempt',
    (name, model) => {
      const field = model.fields.find((f) => f.name === 'workspaceId');
      if (exempt[name]) {
        expect(field).toBeUndefined();
      } else {
        expect(field).toBeDefined();
        expect(field!.isRequired).toBe(!nullable[name]);
      }
    },
  );
});

describe('uniqueness and idempotency guards (AC-02.7)', () => {
  it('rejects a duplicate provider delivery', async () => {
    const data = { provider: 'GITHUB' as const, deliveryId: 'abc-123', eventType: 'issues' };
    await prisma.webhookDelivery.create({ data });
    await expect(prisma.webhookDelivery.create({ data })).rejects.toMatchObject(uniqueViolation);
  });

  it('allows the same delivery id from different providers', async () => {
    await prisma.webhookDelivery.create({
      data: { provider: 'GITHUB', deliveryId: 'same', eventType: 'x' },
    });
    await expect(
      prisma.webhookDelivery.create({
        data: { provider: 'SLACK', deliveryId: 'same', eventType: 'x' },
      }),
    ).resolves.toBeDefined();
  });

  it('rejects a duplicate run idempotency key in one workspace, allows it in another', async () => {
    const { version } = await graph();
    await createRun(prisma, version, { idempotencyKey: 'GITHUB:d1:w1' });
    await expect(
      createRun(prisma, version, { idempotencyKey: 'GITHUB:d1:w1' }),
    ).rejects.toMatchObject(uniqueViolation);

    const other = await graph();
    await expect(
      createRun(prisma, other.version, { idempotencyKey: 'GITHUB:d1:w1' }),
    ).resolves.toBeDefined();
  });

  it('rejects two step records for the same node in one run', async () => {
    const { run } = await graph();
    const step = { runId: run.id, nodeKey: 'log', nodeType: 'util.log', sequence: 1 };
    await prisma.stepRun.create({ data: step });
    await expect(prisma.stepRun.create({ data: step })).rejects.toMatchObject(uniqueViolation);
  });

  it('rejects duplicate membership', async () => {
    const user = await createUser(prisma);
    const workspace = await createWorkspace(prisma, user.id);
    await expect(
      prisma.workspaceMember.create({ data: { workspaceId: workspace.id, userId: user.id } }),
    ).rejects.toMatchObject(uniqueViolation);
  });

  it('rejects duplicate version numbers for a workflow', async () => {
    const { workflow } = await graph();
    await expect(createVersion(prisma, workflow, 1)).rejects.toMatchObject(uniqueViolation);
  });

  it('rejects non-lowercase emails at the database level', async () => {
    await expect(createUser(prisma, { email: 'Mixed@Example.test' })).rejects.toThrow(
      /User_email_lowercase_check/,
    );
  });
});

describe('version immutability (AC-02.5)', () => {
  it('rejects updating a published definition, even with raw SQL', async () => {
    const { version } = await graph();
    await expect(
      prisma.$executeRaw`UPDATE "WorkflowVersion" SET "definition" = '{}'::jsonb WHERE id = ${version.id}::uuid`,
    ).rejects.toThrow(/is immutable/);
    await expect(
      prisma.workflowVersion.update({ where: { id: version.id }, data: { definitionHash: 'x' } }),
    ).rejects.toThrow(/is immutable/);
  });

  it('cannot delete a version or workflow that runs reference', async () => {
    const { version, workflow } = await graph();
    await expect(
      prisma.workflowVersion.delete({ where: { id: version.id } }),
    ).rejects.toMatchObject(foreignKeyViolation);
    await expect(prisma.workflow.delete({ where: { id: workflow.id } })).rejects.toMatchObject(
      foreignKeyViolation,
    );
  });

  it('deletes a workflow without runs together with its versions', async () => {
    const workspace = await createWorkspace(prisma);
    const workflow = await createWorkflow(prisma, workspace.id);
    await createVersion(prisma, workflow, 1);
    await prisma.workflow.delete({ where: { id: workflow.id } });
    expect(await prisma.workflowVersion.count()).toBe(0);
  });
});

describe('run history is independent of the draft (AC-02.6)', () => {
  it('a run still resolves the exact published definition after the draft changes', async () => {
    const { workflow, run } = await graph();
    await prisma.workflow.update({
      where: { id: workflow.id },
      data: { draftDefinition: { schemaVersion: 1, nodes: [], edges: [] }, draftRevision: 1 },
    });
    const reloaded = await prisma.workflowRun.findUniqueOrThrow({
      where: { id: run.id },
      include: { version: true },
    });
    expect(reloaded.version.definition).toEqual(sampleDefinition);
  });
});

describe('deletion behaviour (AC-02.2)', () => {
  it('deleting a workspace cascades through workflows, versions, runs and steps', async () => {
    const { workspace, run } = await graph();
    await prisma.stepRun.create({
      data: { runId: run.id, nodeKey: 'log', nodeType: 'util.log', sequence: 1 },
    });
    await prisma.webhookDelivery.create({
      data: { provider: 'GITHUB', deliveryId: 'd', eventType: 'x', workspaceId: workspace.id },
    });

    await prisma.workspace.delete({ where: { id: workspace.id } });

    expect(await prisma.workflow.count()).toBe(0);
    expect(await prisma.workflowVersion.count()).toBe(0);
    expect(await prisma.workflowRun.count()).toBe(0);
    expect(await prisma.stepRun.count()).toBe(0);
    expect(await prisma.workspaceMember.count()).toBe(0);
    // Deliveries are provider-scoped and outlive the workspace link.
    expect(await prisma.webhookDelivery.findFirstOrThrow()).toMatchObject({ workspaceId: null });
  });

  it('deleting a user removes memberships and tokens but keeps history attribution as null', async () => {
    const { user, workspace, version } = await graph();
    await prisma.refreshToken.create({
      data: {
        userId: user.id,
        familyId: crypto.randomUUID(),
        tokenHash: 'h',
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    await prisma.auditEvent.create({
      data: { workspaceId: workspace.id, actorUserId: user.id, action: 'workflow.published' },
    });

    await prisma.user.delete({ where: { id: user.id } });

    expect(await prisma.workspaceMember.count()).toBe(0);
    expect(await prisma.refreshToken.count()).toBe(0);
    expect(
      (await prisma.workflowVersion.findUniqueOrThrow({ where: { id: version.id } })).publishedById,
    ).toBeNull();
    expect((await prisma.auditEvent.findFirstOrThrow()).actorUserId).toBeNull();
  });

  it('deleting a connection removes its credential and detaches triggers', async () => {
    const { workspace, workflow, version } = await graph();
    const connection = await prisma.integrationConnection.create({
      data: {
        workspaceId: workspace.id,
        provider: 'GITHUB',
        externalAccountId: '42',
        credential: { create: { keyId: 'k1', encryptedAccessToken: 'v1.k1.iv.tag.ct' } },
      },
    });
    await prisma.workflowTrigger.create({
      data: {
        workspaceId: workspace.id,
        workflowId: workflow.id,
        workflowVersionId: version.id,
        provider: 'GITHUB',
        eventType: 'issues.opened',
        resourceKey: '42:owner/repo',
        connectionId: connection.id,
      },
    });

    await prisma.integrationConnection.delete({ where: { id: connection.id } });

    expect(await prisma.integrationCredential.count()).toBe(0);
    expect((await prisma.workflowTrigger.findFirstOrThrow()).connectionId).toBeNull();
  });

  it('rotated refresh tokens link to their replacement', async () => {
    const user = await createUser(prisma);
    const familyId = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 60_000);
    const next = await prisma.refreshToken.create({
      data: { userId: user.id, familyId, tokenHash: 'next', expiresAt },
    });
    const old = await prisma.refreshToken.create({
      data: {
        userId: user.id,
        familyId,
        tokenHash: 'old',
        expiresAt,
        replacedById: next.id,
        revokedAt: new Date(),
      },
    });
    const reloaded = await prisma.refreshToken.findUniqueOrThrow({
      where: { id: next.id },
      include: { replaces: true },
    });
    expect(reloaded.replaces?.id).toBe(old.id);
  });
});

describe('development seed (AC-02.8)', () => {
  it('is idempotent', async () => {
    await seed(prisma);
    await seed(prisma);
    expect(await prisma.user.count({ where: { email: DEMO_EMAIL } })).toBe(1);
    expect(await prisma.workspace.count()).toBe(1);
    expect(await prisma.workflow.count()).toBe(1);
  });

  it('refuses to run in production', () => {
    expect(() => assertSeedAllowed('production')).toThrow(/Refusing to seed/);
    expect(() => assertSeedAllowed('development')).not.toThrow();
  });
});
