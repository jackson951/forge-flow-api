import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConnectionStatus, IntegrationProviderKey, Prisma, WorkspaceRole } from '@prisma/client';
import { PinoLogger } from 'nestjs-pino';
import { createHash, randomBytes } from 'node:crypto';
import { WorkspaceAccess } from '../../common/interfaces/workspace-access.interface';
import { AppConfigService } from '../../config/app-config.service';
import { ExecutionError } from '../../engine/errors';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { GitHubClient, GitHubRepository } from './github/github-client';
import {
  ConnectionDeniedError,
  INTEGRATION_PROVIDERS,
  IntegrationProvider,
} from './providers/integration-provider.interface';

const STATE_TTL_MS = 10 * 60_000;

/** The only connection fields that leave the backend. */
export const CONNECTION_SELECT = {
  id: true,
  provider: true,
  status: true,
  externalAccountId: true,
  accountLabel: true,
  scopes: true,
  metadata: true,
  createdAt: true,
  updatedAt: true,
  lastUsedAt: true,
} satisfies Prisma.IntegrationConnectionSelect;

export type ConnectionSummary = Prisma.IntegrationConnectionGetPayload<{
  select: typeof CONNECTION_SELECT;
}>;

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

@Injectable()
export class IntegrationsService {
  constructor(
    @Inject(INTEGRATION_PROVIDERS) private readonly providers: IntegrationProvider[],
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
    private readonly audit: AuditService,
    private readonly github: GitHubClient,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(IntegrationsService.name);
  }

  listProviders() {
    return this.providers.map((p) => ({ key: p.key, configured: p.isConfigured() }));
  }

  listConnections(workspaceId: string): Promise<ConnectionSummary[]> {
    return this.prisma.integrationConnection.findMany({
      where: { workspaceId },
      select: CONNECTION_SELECT,
      orderBy: { createdAt: 'asc' },
    });
  }

  /** Issues a single-use `state` (stored only as a hash) bound to user, workspace and provider. */
  async startConnect(
    access: WorkspaceAccess,
    key: IntegrationProviderKey,
  ): Promise<{ url: string }> {
    const provider = this.providers.find((p) => p.key === key);
    if (!provider?.isConfigured()) {
      throw new ServiceUnavailableException(`${key} is not configured on this server`);
    }
    const state = randomBytes(32).toString('base64url');
    await this.prisma.oAuthState.create({
      data: {
        stateHash: sha256(state),
        provider: key,
        userId: access.userId,
        workspaceId: access.workspaceId,
        expiresAt: new Date(Date.now() + STATE_TTL_MS),
      },
    });
    return { url: provider.connectUrl(state) };
  }

  /**
   * OAuth/installation redirect target. Returns where to send the browser: the frontend, with
   * only a status and a generic reason — never tokens or provider error details.
   */
  async handleCallback(slug: string, query: Record<string, string | undefined>): Promise<string> {
    const provider = this.providers.find((p) => p.slug === slug && p.isConfigured());
    if (!provider) return this.frontend(slug, { status: 'error', reason: 'unknown_provider' });

    const state = query.state ? await this.consumeState(query.state, provider.key) : null;
    if (!state) return this.frontend(slug, { status: 'error', reason: 'invalid_state' });
    if (query.error) return this.frontend(slug, { status: 'error', reason: 'denied' });

    // The admin who started the flow must still be allowed to manage integrations.
    const member = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: state.workspaceId, userId: state.userId } },
      select: { role: true },
    });
    if (!member || member.role === WorkspaceRole.MEMBER) {
      return this.frontend(slug, { status: 'error', reason: 'not_authorized' });
    }

    try {
      const details = await provider.completeConnection(query);
      const connection = await this.prisma.$transaction(async (tx) => {
        const saved = await tx.integrationConnection.upsert({
          where: {
            workspaceId_provider_externalAccountId: {
              workspaceId: state.workspaceId,
              provider: provider.key,
              externalAccountId: details.externalAccountId,
            },
          },
          create: {
            workspaceId: state.workspaceId,
            provider: provider.key,
            externalAccountId: details.externalAccountId,
            accountLabel: details.accountLabel,
            scopes: details.scopes,
            metadata: details.metadata,
            createdById: state.userId,
          },
          update: {
            status: ConnectionStatus.CONNECTED,
            accountLabel: details.accountLabel,
            scopes: details.scopes,
            metadata: details.metadata,
          },
          select: { id: true },
        });
        await this.audit.record(
          {
            action: 'integration.connected',
            workspaceId: state.workspaceId,
            actorUserId: state.userId,
            targetType: 'IntegrationConnection',
            targetId: saved.id,
            metadata: { provider: provider.key, account: details.accountLabel ?? null },
          },
          tx,
        );
        return saved;
      });
      return this.frontend(slug, { status: 'connected', connectionId: connection.id });
    } catch (err) {
      const reason = err instanceof ConnectionDeniedError ? err.reason : 'provider_error';
      this.logger.warn({ provider: provider.key, reason }, 'Integration connection failed');
      return this.frontend(slug, { status: 'error', reason });
    }
  }

  /** Unbinds the connection from this workspace. Triggers using it stop matching events. */
  async disconnect(access: WorkspaceAccess, connectionId: string): Promise<void> {
    const connection = await this.findConnection(access.workspaceId, connectionId);
    await this.prisma.$transaction(async (tx) => {
      await tx.integrationConnection.delete({ where: { id: connection.id } });
      await this.audit.record(
        {
          action: 'integration.disconnected',
          workspaceId: access.workspaceId,
          actorUserId: access.userId,
          targetType: 'IntegrationConnection',
          targetId: connection.id,
          metadata: { provider: connection.provider },
        },
        tx,
      );
    });
  }

  async listGitHubRepositories(
    workspaceId: string,
    connectionId: string,
  ): Promise<GitHubRepository[]> {
    const connection = await this.findConnection(workspaceId, connectionId);
    if (connection.provider !== IntegrationProviderKey.GITHUB) {
      throw new NotFoundException('Connection not found');
    }
    if (connection.status !== ConnectionStatus.CONNECTED) {
      throw new ConflictException('This GitHub connection needs attention; reconnect it');
    }
    try {
      return await this.github.listRepositories(Number(connection.externalAccountId));
    } catch (err) {
      if (err instanceof ExecutionError && err.category === 'PROVIDER_AUTH') {
        await this.prisma.integrationConnection.update({
          where: { id: connection.id },
          data: { status: ConnectionStatus.NEEDS_ATTENTION },
        });
        throw new ConflictException('GitHub access was revoked; reconnect the integration');
      }
      if (err instanceof ExecutionError) throw new ServiceUnavailableException(err.message);
      throw err;
    }
  }

  private async consumeState(state: string, provider: IntegrationProviderKey) {
    const stateHash = sha256(state);
    // Conditional update: a state can be used exactly once, and only before it expires.
    const consumed = await this.prisma.oAuthState.updateMany({
      where: { stateHash, provider, consumedAt: null, expiresAt: { gt: new Date() } },
      data: { consumedAt: new Date() },
    });
    if (consumed.count !== 1) return null;
    return this.prisma.oAuthState.findUniqueOrThrow({
      where: { stateHash },
      select: { userId: true, workspaceId: true },
    });
  }

  private async findConnection(workspaceId: string, id: string) {
    const connection = await this.prisma.integrationConnection.findFirst({
      where: { id, workspaceId },
      select: { id: true, provider: true, status: true, externalAccountId: true },
    });
    if (!connection) throw new NotFoundException('Connection not found');
    return connection;
  }

  private frontend(slug: string, params: Record<string, string>): string {
    const url = new URL('/integrations', this.config.get('FRONTEND_URL'));
    url.searchParams.set('provider', slug);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    return url.toString();
  }
}
