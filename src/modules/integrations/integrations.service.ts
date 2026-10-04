import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConnectionStatus, IntegrationProviderKey, Prisma, WorkspaceRole } from '@prisma/client';
import { PinoLogger } from 'nestjs-pino';
import { createHash, randomBytes } from 'node:crypto';
import { WorkspaceAccess } from '../../common/interfaces/workspace-access.interface';
import { AppConfigService } from '../../config/app-config.service';
import { ExecutionError } from '../../engine/errors';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { EncryptionService } from '../../infrastructure/crypto/encryption.service';
import { CredentialStore } from './credentials/credential-store';
import { GitHubClient, GitHubRepository } from './github/github-client';
import {
  MicrosoftAppCredentialsError,
  MicrosoftClient,
  TodoList,
} from './microsoft/microsoft-client';
import { MicrosoftTokenManager } from './microsoft/microsoft-token-manager';
import { JiraAppCredentialsError, JiraClient, JiraSite } from './jira/jira-client';
import { JiraTokenManager } from './jira/jira-token-manager';
import { GmailAppCredentialsError, GmailClient } from './gmail/gmail-client';
import { GmailTokenManager } from './gmail/gmail-token-manager';
import { SlackChannel, SlackClient } from './slack/slack-client';
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
  statusReason: true,
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
const verifierAad = (stateHash: string) => `oauth-state:${stateHash}:codeVerifier`;
const pkceChallenge = (verifier: string) =>
  createHash('sha256').update(verifier).digest('base64url');

@Injectable()
export class IntegrationsService {
  constructor(
    @Inject(INTEGRATION_PROVIDERS) private readonly providers: IntegrationProvider[],
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
    private readonly audit: AuditService,
    private readonly github: GitHubClient,
    private readonly slack: SlackClient,
    private readonly microsoft: MicrosoftClient,
    private readonly microsoftTokens: MicrosoftTokenManager,
    private readonly credentials: CredentialStore,
    private readonly encryption: EncryptionService,
    private readonly logger: PinoLogger,
    private readonly jira: JiraClient,
    private readonly jiraTokens: JiraTokenManager,
    private readonly gmail: GmailClient,
    private readonly gmailTokens: GmailTokenManager,
  ) {
    this.logger.setContext(IntegrationsService.name);
  }

  /** OAuth providers, plus HTTP (credential form, Part 24). */
  listProviders() {
    return [
      ...this.providers.map((p) => ({
        key: p.key,
        configured: p.isConfigured(),
        connectionType: 'OAUTH' as const,
      })),
      {
        key: IntegrationProviderKey.HTTP,
        configured: this.config.http.enabled && this.encryption.isConfigured(),
        connectionType: 'CREDENTIALS' as const,
      },
    ];
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
    const stateHash = sha256(state);
    // PKCE verifier: random, kept only encrypted with the state, bound to it via AAD.
    const codeVerifier = provider.usesPkce ? randomBytes(32).toString('base64url') : undefined;
    await this.prisma.oAuthState.create({
      data: {
        stateHash,
        provider: key,
        userId: access.userId,
        workspaceId: access.workspaceId,
        encryptedCodeVerifier: codeVerifier
          ? this.encryption.encrypt(codeVerifier, verifierAad(stateHash))
          : null,
        expiresAt: new Date(Date.now() + STATE_TTL_MS),
      },
    });
    return {
      url: provider.connectUrl(
        state,
        codeVerifier ? { codeChallenge: pkceChallenge(codeVerifier) } : undefined,
      ),
    };
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

    let codeVerifier: string | undefined;
    if (provider.usesPkce) {
      try {
        codeVerifier = state.encryptedCodeVerifier
          ? this.encryption.decrypt(state.encryptedCodeVerifier, verifierAad(state.stateHash))
          : undefined;
      } catch {
        codeVerifier = undefined;
      }
      if (!codeVerifier) return this.frontend(slug, { status: 'error', reason: 'invalid_state' });
    }

    try {
      const { credential, ...details } = await provider.completeConnection(query, {
        codeVerifier,
      });
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
            metadata: details.metadata as Prisma.InputJsonObject | undefined,
            createdById: state.userId,
          },
          update: {
            status: ConnectionStatus.CONNECTED,
            statusReason: null,
            accountLabel: details.accountLabel,
            scopes: details.scopes,
            metadata: details.metadata as Prisma.InputJsonObject | undefined,
          },
          select: { id: true },
        });
        // Re-connecting replaces the stored token (e.g. after a revocation).
        if (credential) await this.credentials.save(saved.id, credential, tx);
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
      // ConnectionDeniedError messages are ours (provider error codes only, never tokens or
      // provider bodies): log them so operators can diagnose; the browser gets only `reason`.
      this.logger.warn(
        {
          provider: provider.key,
          reason,
          detail: err instanceof ConnectionDeniedError ? err.message : 'unexpected error',
        },
        'Integration connection failed',
      );
      return this.frontend(slug, { status: 'error', reason });
    }
  }

  /**
   * Revokes at the provider where supported (best effort), then deletes the connection and,
   * by cascade, its encrypted credentials. Triggers using it stop matching events.
   */
  async disconnect(access: WorkspaceAccess, connectionId: string): Promise<void> {
    const connection = await this.findConnection(access.workspaceId, connectionId);
    const provider = this.providers.find((p) => p.key === connection.provider);
    let revoked: boolean | null = null;
    if (provider?.revoke && this.encryption.isConfigured()) {
      const credential = await this.credentials.get(access.workspaceId, connection.id);
      if (credential?.accessToken || credential?.refreshToken) {
        revoked = await provider.revoke(credential).then(
          () => true,
          (err: Error) => {
            this.logger.warn(
              { provider: connection.provider, error: err.message },
              'Provider revocation failed; deleting locally anyway',
            );
            return false;
          },
        );
      }
    }
    if (provider?.beforeDisconnect) {
      await provider
        .beforeDisconnect({ id: connection.id, workspaceId: access.workspaceId })
        .catch((err: Error) =>
          this.logger.warn(
            { provider: connection.provider, error: err.message },
            'Provider clean-up before disconnect failed; deleting locally anyway',
          ),
        );
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.integrationConnection.delete({ where: { id: connection.id } });
      await this.audit.record(
        {
          action: 'integration.disconnected',
          workspaceId: access.workspaceId,
          actorUserId: access.userId,
          targetType: 'IntegrationConnection',
          targetId: connection.id,
          metadata: { provider: connection.provider, revokedAtProvider: revoked },
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
      throw await this.providerFailure(connection.id, 'GitHub', err);
    }
  }

  /** Channels the Slack bot can post to (for action configuration). IDs and names only. */
  async listSlackChannels(
    workspaceId: string,
    connectionId: string,
    cursor?: string,
    limit = 100,
  ): Promise<{ items: SlackChannel[]; nextCursor: string | null }> {
    const connection = await this.findConnection(workspaceId, connectionId);
    if (connection.provider !== IntegrationProviderKey.SLACK) {
      throw new NotFoundException('Connection not found');
    }
    const credential =
      connection.status === ConnectionStatus.CONNECTED
        ? await this.credentials.get(workspaceId, connection.id)
        : null;
    if (!credential?.accessToken) {
      throw new ConflictException('This Slack connection needs attention; reconnect it');
    }
    try {
      const page = await this.slack.listChannels(credential.accessToken, cursor, limit);
      return { items: page.channels, nextCursor: page.nextCursor };
    } catch (err) {
      throw await this.providerFailure(connection.id, 'Slack', err);
    }
  }

  /** The connecting user's Microsoft To Do lists (for action configuration). */
  async listMicrosoftTodoLists(workspaceId: string, connectionId: string): Promise<TodoList[]> {
    const connection = await this.findConnection(workspaceId, connectionId);
    if (connection.provider !== IntegrationProviderKey.MICROSOFT) {
      throw new NotFoundException('Connection not found');
    }
    if (connection.status !== ConnectionStatus.CONNECTED) {
      throw new ConflictException('This Microsoft connection needs attention; reconnect it');
    }
    try {
      return await this.microsoftTokens.withToken(workspaceId, connection.id, (token) =>
        this.microsoft.todoLists(token),
      );
    } catch (err) {
      throw await this.providerFailure(connection.id, 'Microsoft', err);
    }
  }

  /** Gmail labels of the mailbox (Part 26, FR-26.11): id, name, type. */
  async listGmailLabels(workspaceId: string, connectionId: string) {
    const connection = await this.findConnection(workspaceId, connectionId);
    if (connection.provider !== IntegrationProviderKey.GMAIL)
      throw new NotFoundException('Connection not found');
    if (connection.status !== ConnectionStatus.CONNECTED) {
      throw new ConflictException('This Gmail connection needs attention; reconnect it');
    }
    try {
      const body = await this.gmailTokens.withToken(workspaceId, connection.id, (token) =>
        this.gmail.labels(token),
      );
      return (body.labels ?? [])
        .filter((l) => typeof l.id === 'string')
        .map((l) => ({ id: l.id!, name: l.name ?? l.id!, type: l.type ?? 'user' }));
    } catch (err) {
      throw await this.providerFailure(connection.id, 'Gmail', err);
    }
  }

  // ── Jira pickers (Part 25, FR-25.9): minimal fields for the editor ─────────

  /** The grant's Jira sites, read live (and refreshed on the connection). */
  async listJiraSites(workspaceId: string, connectionId: string): Promise<JiraSite[]> {
    const connection = await this.jiraConnection(workspaceId, connectionId);
    try {
      const sites = await this.jiraTokens.withToken(workspaceId, connection.id, (token) =>
        this.jira.sites(token),
      );
      const current = await this.prisma.integrationConnection.findUniqueOrThrow({
        where: { id: connection.id },
        select: { metadata: true },
      });
      await this.prisma.integrationConnection.update({
        where: { id: connection.id },
        data: {
          metadata: {
            ...((current.metadata as Prisma.JsonObject | null) ?? {}),
            sites,
          } as unknown as Prisma.InputJsonObject,
        },
      });
      return sites;
    } catch (err) {
      throw await this.providerFailure(connection.id, 'Jira', err);
    }
  }

  async listJiraProjects(
    workspaceId: string,
    connectionId: string,
    siteId: string,
    query?: string,
  ) {
    const body = await this.jiraCall<{ values?: { id?: string; key?: string; name?: string }[] }>(
      workspaceId,
      connectionId,
      siteId,
      `/project/search?maxResults=50${query ? `&query=${encodeURIComponent(query)}` : ''}`,
    );
    return (body.values ?? []).map((p) => ({
      id: p.id ?? null,
      key: p.key ?? null,
      name: p.name ?? null,
    }));
  }

  async listJiraIssueTypes(
    workspaceId: string,
    connectionId: string,
    siteId: string,
    project: string,
  ) {
    const body = await this.jiraCall<{ issueTypes?: JiraNamed[]; values?: JiraNamed[] }>(
      workspaceId,
      connectionId,
      siteId,
      `/issue/createmeta/${encodeURIComponent(project)}/issuetypes`,
    );
    return (body.issueTypes ?? body.values ?? []).map((t) => ({
      id: t.id ?? null,
      name: t.name ?? null,
      subtask: Boolean(t.subtask),
    }));
  }

  async listJiraStatuses(
    workspaceId: string,
    connectionId: string,
    siteId: string,
    project: string,
  ) {
    const body = await this.jiraCall<{ statuses?: JiraNamed[] }[]>(
      workspaceId,
      connectionId,
      siteId,
      `/project/${encodeURIComponent(project)}/statuses`,
    );
    const byName = new Map<string, { id: string | null; name: string }>();
    for (const type of Array.isArray(body) ? body : []) {
      for (const status of type.statuses ?? []) {
        if (status.name && !byName.has(status.name))
          byName.set(status.name, { id: status.id ?? null, name: status.name });
      }
    }
    return [...byName.values()];
  }

  /** Assignable users: account ids and display names only (no e-mail addresses). */
  async listJiraUsers(
    workspaceId: string,
    connectionId: string,
    siteId: string,
    project: string,
    query?: string,
  ) {
    const body = await this.jiraCall<
      { accountId?: string; displayName?: string; active?: boolean }[]
    >(
      workspaceId,
      connectionId,
      siteId,
      `/user/assignable/search?maxResults=20&project=${encodeURIComponent(project)}${query ? `&query=${encodeURIComponent(query)}` : ''}`,
    );
    return (Array.isArray(body) ? body : [])
      .filter((u) => typeof u.accountId === 'string' && u.active !== false)
      .map((u) => ({ accountId: u.accountId!, displayName: u.displayName ?? null }));
  }

  private async jiraConnection(workspaceId: string, connectionId: string) {
    const connection = await this.findConnection(workspaceId, connectionId);
    if (connection.provider !== IntegrationProviderKey.JIRA)
      throw new NotFoundException('Connection not found');
    if (connection.status !== ConnectionStatus.CONNECTED) {
      throw new ConflictException('This Jira connection needs attention; reconnect it');
    }
    return connection;
  }

  private async jiraCall<T>(
    workspaceId: string,
    connectionId: string,
    siteId: string,
    path: string,
  ): Promise<T> {
    const connection = await this.jiraConnection(workspaceId, connectionId);
    try {
      const site = await this.jiraTokens.site(workspaceId, connection.id, siteId);
      return await this.jiraTokens.withToken(workspaceId, connection.id, (token) =>
        this.jira.jira<T>(token, site.cloudId, 'GET', path),
      );
    } catch (err) {
      throw await this.providerFailure(connection.id, 'Jira', err);
    }
  }

  /**
   * Maps a provider failure during an API call: revoked access marks the connection
   * NEEDS_ATTENTION (409); other provider errors are 503 with the safe message.
   */
  private async providerFailure(connectionId: string, name: string, err: unknown) {
    // FlowForge's own app credentials were rejected: a server problem, not the user's.
    if (
      err instanceof MicrosoftAppCredentialsError ||
      err instanceof JiraAppCredentialsError ||
      err instanceof GmailAppCredentialsError
    ) {
      this.logger.error({ provider: name }, err.message);
      return new ServiceUnavailableException(`${name} integration is misconfigured on this server`);
    }
    if (err instanceof ExecutionError && err.category === 'PROVIDER_AUTH') {
      await this.prisma.integrationConnection.update({
        where: { id: connectionId },
        data: { status: ConnectionStatus.NEEDS_ATTENTION, statusReason: 'TOKEN_REVOKED' },
      });
      return new ConflictException(`${name} access was revoked; reconnect the integration`);
    }
    if (err instanceof ExecutionError) {
      this.logger.warn(
        { provider: name, category: err.category, detail: err.message },
        'Provider call failed',
      );
      // Permanent provider answers are about this connection or request (shown to the user);
      // retryable ones mean "try again later".
      return err.retryable
        ? new ServiceUnavailableException(err.message)
        : new UnprocessableEntityException(err.message);
    }
    return err;
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
      select: { userId: true, workspaceId: true, stateHash: true, encryptedCodeVerifier: true },
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

interface JiraNamed {
  id?: string;
  name?: string;
  subtask?: boolean;
}
