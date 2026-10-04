import { NestExpressApplication } from '@nestjs/platform-express';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppConfigService } from '../../src/config/app-config.service';
import { EncryptionService } from '../../src/infrastructure/crypto/encryption.service';
import { PrismaService } from '../../src/infrastructure/prisma/prisma.service';
import { CredentialStore } from '../../src/modules/integrations/credentials/credential-store';
import {
  INTEGRATION_PROVIDERS,
  IntegrationProvider,
} from '../../src/modules/integrations/providers/integration-provider.interface';
import { bearer, registerUser, RegisteredUser } from '../support/auth';
import { createTestApp } from '../support/create-app';
import { FAKE_SECRETS } from '../support/fake-secrets';
import { truncateAll } from '../support/test-database';

const ACCESS = FAKE_SECRETS.slackAccess;
const REFRESH = FAKE_SECRETS.slackRefresh;

/** A token-storing provider with a revoke hook (Slack-like), to test disconnect behaviour. */
const revoke = jest.fn<Promise<void>, [unknown]>();
const fakeProvider: IntegrationProvider = {
  key: 'SLACK',
  slug: 'slack',
  isConfigured: () => true,
  connectUrl: () => 'https://example.test',
  completeConnection: () => Promise.reject(new Error('unused')),
  revoke,
};

/** EncryptionService with an explicit keyring, for rotation scenarios. */
function encryptionWith(keys: string, active: string): EncryptionService {
  const config = {
    get: (k: string) => ({ ENCRYPTION_KEYS: keys, ENCRYPTION_ACTIVE_KEY_ID: active })[k],
  } as unknown as AppConfigService;
  return new EncryptionService(config);
}

describe('Integration credential security (integration)', () => {
  let app: NestExpressApplication;
  let server: App;
  let prisma: PrismaService;
  let store: CredentialStore;
  let owner: RegisteredUser;
  let ws: string;

  async function connection(workspaceId = ws, externalAccountId = randomBytes(4).toString('hex')) {
    return prisma.integrationConnection.create({
      data: {
        workspaceId,
        provider: 'SLACK',
        externalAccountId,
        accountLabel: 'Acme Slack',
        scopes: ['chat:write'],
      },
    });
  }

  beforeAll(async () => {
    app = await createTestApp((b) =>
      b.overrideProvider(INTEGRATION_PROVIDERS).useValue([fakeProvider]),
    );
    server = app.getHttpServer();
    prisma = app.get(PrismaService);
    store = app.get(CredentialStore);
    await truncateAll(prisma);
    owner = await registerUser(server);
    ws = (await prisma.workspaceMember.findFirstOrThrow({ where: { userId: owner.id } }))
      .workspaceId;
  });

  afterAll(() => app.close());

  it('stores credentials encrypted with authenticated encryption (AC-17.1)', async () => {
    const conn = await connection();
    const expiresAt = new Date(Date.now() + 3_600_000);
    await store.save(conn.id, {
      accessToken: ACCESS,
      refreshToken: REFRESH,
      accessTokenExpiresAt: expiresAt,
    });

    const row = await prisma.integrationCredential.findUniqueOrThrow({
      where: { connectionId: conn.id },
    });
    expect(row.keyId).toBe('test1');
    expect(row.encryptedAccessToken).toMatch(/^v1\.test1\./);
    const raw = await prisma.$queryRaw<
      unknown[]
    >`SELECT * FROM "IntegrationCredential" WHERE "connectionId" = ${conn.id}::uuid`;
    expect(JSON.stringify(raw)).not.toContain('canary');

    expect(await store.get(ws, conn.id)).toMatchObject({
      accessToken: ACCESS,
      refreshToken: REFRESH,
      accessTokenExpiresAt: expiresAt,
      provider: 'SLACK',
      status: 'CONNECTED',
    });
  });

  it("does not return another workspace's credentials", async () => {
    const conn = await connection();
    await store.save(conn.id, { accessToken: ACCESS });
    const other = await registerUser(server);
    const otherWs = (await prisma.workspaceMember.findFirstOrThrow({ where: { userId: other.id } }))
      .workspaceId;
    expect(await store.get(otherWs, conn.id)).toBeNull();
  });

  it('a ciphertext copied to another connection cannot be decrypted', async () => {
    const a = await connection();
    const b = await connection();
    await store.save(a.id, { accessToken: ACCESS });
    await store.save(b.id, { accessToken: 'something-else' });
    await prisma.$executeRaw`
      UPDATE "IntegrationCredential" SET "encryptedAccessToken" =
        (SELECT "encryptedAccessToken" FROM "IntegrationCredential" WHERE "connectionId" = ${a.id}::uuid)
      WHERE "connectionId" = ${b.id}::uuid`;
    await expect(store.get(ws, b.id)).rejects.toThrow('decryption failed');
  });

  it('API responses never include tokens or ciphertext (AC-17.3)', async () => {
    const conn = await connection();
    await store.save(conn.id, { accessToken: ACCESS, refreshToken: REFRESH });
    const res = await request(server)
      .get(`/api/v1/workspaces/${ws}/integrations`)
      .set(bearer(owner.accessToken));
    expect(res.status).toBe(200);
    expect(res.body.find((c: { id: string }) => c.id === conn.id)).toEqual({
      id: conn.id,
      provider: 'SLACK',
      status: 'CONNECTED',
      statusReason: null,
      externalAccountId: conn.externalAccountId,
      accountLabel: 'Acme Slack',
      scopes: ['chat:write'],
      metadata: null,
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
      lastUsedAt: null,
    });
    expect(res.text).not.toMatch(/canary|encrypted|v1\.test1\.|credential/i);
  });

  it('disconnect revokes at the provider, then deletes the credentials (AC-17.6)', async () => {
    revoke.mockResolvedValueOnce(undefined);
    const conn = await connection();
    await store.save(conn.id, { accessToken: ACCESS, refreshToken: REFRESH });

    await request(server)
      .delete(`/api/v1/workspaces/${ws}/integrations/${conn.id}`)
      .set(bearer(owner.accessToken))
      .expect(204);

    expect(revoke).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: ACCESS, refreshToken: REFRESH }),
    );
    expect(await prisma.integrationCredential.count({ where: { connectionId: conn.id } })).toBe(0);
    expect(await prisma.integrationConnection.count({ where: { id: conn.id } })).toBe(0);
    const audit = await prisma.auditEvent.findFirstOrThrow({
      where: { action: 'integration.disconnected', targetId: conn.id },
    });
    expect(audit.metadata).toMatchObject({ provider: 'SLACK', revokedAtProvider: true });
  });

  it('a failing provider revocation still deletes the local credentials', async () => {
    revoke.mockRejectedValueOnce(new Error(`provider down; token was ${ACCESS}`));
    const conn = await connection();
    await store.save(conn.id, { accessToken: ACCESS });
    await request(server)
      .delete(`/api/v1/workspaces/${ws}/integrations/${conn.id}`)
      .set(bearer(owner.accessToken))
      .expect(204);
    expect(await prisma.integrationCredential.count({ where: { connectionId: conn.id } })).toBe(0);
  });

  it('rotates keys: re-encrypt with a new key, then the old key can be removed (AC-17.7)', async () => {
    const oldKeys = process.env.ENCRYPTION_KEYS!; // "test1:<key>"
    const newKey = `k2:${randomBytes(32).toString('base64')}`;
    const conn = await connection();
    await store.save(conn.id, { accessToken: ACCESS, refreshToken: REFRESH });

    // Step 1+2: add k2 as the active key (keep test1) and re-encrypt.
    const rotating = new CredentialStore(prisma, encryptionWith(`${oldKeys},${newKey}`, 'k2'));
    const corrupted = await prisma.integrationCredential.findMany({
      where: { keyId: 'test1' },
      select: { connectionId: true },
    });
    const { updated, failedConnectionIds } = await rotating.reencryptAll();
    expect(updated).toBeGreaterThanOrEqual(1);
    // The row deliberately corrupted in an earlier test is reported, not fatal.
    expect(failedConnectionIds).toHaveLength(1);
    expect(corrupted.map((c) => c.connectionId)).toEqual(
      expect.arrayContaining(failedConnectionIds),
    );
    expect(await prisma.integrationCredential.count({ where: { keyId: { not: 'k2' } } })).toBe(1);

    // Step 3: only k2 remains configured; everything still decrypts.
    const afterRotation = new CredentialStore(prisma, encryptionWith(newKey, 'k2'));
    expect(await afterRotation.get(ws, conn.id)).toMatchObject({
      accessToken: ACCESS,
      refreshToken: REFRESH,
    });
    // …and the old key alone no longer can.
    await expect(store.get(ws, conn.id)).rejects.toThrow('unknown key id');

    // Re-running migrates nothing new and still reports the unreadable row.
    expect(await afterRotation.reencryptAll()).toEqual({ updated: 0, failedConnectionIds });
    expect(
      await prisma.auditEvent.count({ where: { action: 'integration.credentials_reencrypted' } }),
    ).toBe(2);
  });

  it('rejects secrets pasted into workflow definitions (AC-17.5)', async () => {
    const base = `/api/v1/workspaces/${ws}/workflows`;
    const wf = await request(server)
      .post(base)
      .set(bearer(owner.accessToken))
      .send({ name: 'leaky' });
    const res = await request(server)
      .post(`${base}/${wf.body.id}/validate`)
      .set(bearer(owner.accessToken))
      .send({
        definition: {
          schemaVersion: 1,
          nodes: [
            { key: 'trigger', kind: 'TRIGGER', type: 'manual.trigger', config: {} },
            {
              key: 'log',
              kind: 'ACTION',
              type: 'util.log',
              config: { message: `token ${ACCESS}` },
            },
          ],
          edges: [{ from: 'trigger', to: 'log' }],
        },
      });
    expect(res.body.issues).toEqual([
      expect.objectContaining({ code: 'SECRET_IN_CONFIG', nodeKey: 'log', path: 'message' }),
    ]);
  });
});
