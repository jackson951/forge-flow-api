import {
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConnectionStatus, IntegrationProviderKey, Prisma } from '@prisma/client';
import { PinoLogger } from 'nestjs-pino';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { WorkspaceAccess } from '../../../common/interfaces/workspace-access.interface';
import { AppConfigService } from '../../../config/app-config.service';
import { ExecutionError } from '../../../engine/errors';
import { EncryptionService } from '../../../infrastructure/crypto/encryption.service';
import { EgressClient } from '../../../infrastructure/egress/egress-client';
import {
  checkUrl,
  EgressBlockedError,
  hostAllowed,
} from '../../../infrastructure/egress/egress-policy';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { AuditService } from '../../audit/audit.service';
import { CredentialStore } from '../credentials/credential-store';
import { CONNECTION_SELECT, ConnectionSummary } from '../integrations.service';
import {
  allowedHostSchema,
  applyAuth,
  HttpConnectionMetadata,
  httpCredentialsSchema,
  splitCredentials,
} from './http-auth';
import { classifyStatus, classifyTransportError, resolveRequestUrl } from './http-request';

export interface HttpConnectionInput {
  name: string;
  credentials: unknown;
  baseUrl?: string | null;
  allowedHosts?: string[] | null;
}

export interface ConnectionTestResult {
  ok: boolean;
  status?: number;
  category?: string;
  message?: string;
  durationMs?: number;
}

const TEST_TIMEOUT_MS = 10_000;

/**
 * HTTP connections (Part 24, FR-24.4): credential-based, created by an ADMIN with a form
 * instead of OAuth. Secrets are validated, sealed (Part 17 envelope, AAD bound to the
 * connection) and never returned; only non-secret settings and a hint are visible.
 */
@Injectable()
export class HttpConnectionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly credentials: CredentialStore,
    private readonly encryption: EncryptionService,
    private readonly egress: EgressClient,
    private readonly audit: AuditService,
    private readonly config: AppConfigService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(HttpConnectionsService.name);
  }

  async create(access: WorkspaceAccess, input: HttpConnectionInput): Promise<ConnectionSummary> {
    this.assertAvailable();
    const { secrets, metadata: auth } = splitCredentials(this.parseCredentials(input.credentials));
    const metadata: HttpConnectionMetadata = {
      ...auth,
      ...this.settings(input.baseUrl, input.allowedHosts),
    };
    return this.prisma.$transaction(async (tx) => {
      const connection = await tx.integrationConnection.create({
        data: {
          workspaceId: access.workspaceId,
          provider: IntegrationProviderKey.HTTP,
          // Many HTTP connections per workspace: the unique account id is generated.
          externalAccountId: randomUUID(),
          accountLabel: input.name,
          scopes: [],
          metadata: metadata as unknown as Prisma.InputJsonObject,
          createdById: access.userId,
        },
        select: CONNECTION_SELECT,
      });
      await this.credentials.savePayload(connection.id, secrets, tx);
      await this.audit.record(
        {
          action: 'integration.connected',
          workspaceId: access.workspaceId,
          actorUserId: access.userId,
          targetType: 'IntegrationConnection',
          targetId: connection.id,
          metadata: { provider: IntegrationProviderKey.HTTP, authType: metadata.authType },
        },
        tx,
      );
      return connection;
    });
  }

  /** Name and non-secret settings. `null` clears a setting. */
  async update(
    access: WorkspaceAccess,
    connectionId: string,
    input: Partial<Omit<HttpConnectionInput, 'credentials'>>,
  ): Promise<ConnectionSummary> {
    const existing = await this.find(access.workspaceId, connectionId);
    const current = existing.metadata as unknown as HttpConnectionMetadata;
    const next = this.settings(
      input.baseUrl === undefined ? current.baseUrl : input.baseUrl,
      input.allowedHosts === undefined ? current.allowedHosts : input.allowedHosts,
    );
    const metadata: HttpConnectionMetadata = {
      ...current,
      baseUrl: next.baseUrl,
      allowedHosts: next.allowedHosts,
    };
    return this.prisma.$transaction(async (tx) => {
      const connection = await tx.integrationConnection.update({
        where: { id: connectionId },
        data: {
          ...(input.name !== undefined && { accountLabel: input.name }),
          metadata: stripUndefined(metadata),
        },
        select: CONNECTION_SELECT,
      });
      await this.audit.record(
        {
          action: 'integration.updated',
          workspaceId: access.workspaceId,
          actorUserId: access.userId,
          targetType: 'IntegrationConnection',
          targetId: connectionId,
          metadata: { provider: IntegrationProviderKey.HTTP },
        },
        tx,
      );
      return connection;
    });
  }

  /** Replaces the secrets (and possibly the auth type); the connection is CONNECTED again. */
  async rotate(
    access: WorkspaceAccess,
    connectionId: string,
    rawCredentials: unknown,
  ): Promise<ConnectionSummary> {
    this.assertAvailable();
    const existing = await this.find(access.workspaceId, connectionId);
    const current = existing.metadata as unknown as HttpConnectionMetadata;
    const { secrets, metadata: auth } = splitCredentials(this.parseCredentials(rawCredentials));
    const metadata: HttpConnectionMetadata = {
      ...auth,
      baseUrl: current.baseUrl,
      allowedHosts: current.allowedHosts,
    };
    return this.prisma.$transaction(async (tx) => {
      await this.credentials.savePayload(connectionId, secrets, tx);
      const connection = await tx.integrationConnection.update({
        where: { id: connectionId },
        data: { metadata: stripUndefined(metadata), status: ConnectionStatus.CONNECTED },
        select: CONNECTION_SELECT,
      });
      await this.audit.record(
        {
          action: 'integration.credentials_rotated',
          workspaceId: access.workspaceId,
          actorUserId: access.userId,
          targetType: 'IntegrationConnection',
          targetId: connectionId,
          metadata: { provider: IntegrationProviderKey.HTTP, authType: metadata.authType },
        },
        tx,
      );
      return connection;
    });
  }

  /**
   * One request with the connection's credentials, through the same egress guard as the
   * action. Returns only the outcome — never the response body or headers, so the endpoint
   * cannot be used to read pages.
   */
  async test(
    access: WorkspaceAccess,
    connectionId: string,
    input: { url: string; method?: 'GET' | 'HEAD' },
  ): Promise<ConnectionTestResult> {
    this.assertAvailable();
    const connection = await this.credentials.getHttp(access.workspaceId, connectionId);
    if (!connection) throw new NotFoundException('Connection not found');
    const metadata = connection.metadata as unknown as HttpConnectionMetadata;
    const method = input.method ?? 'GET';
    try {
      const url = resolveRequestUrl(input.url, metadata.baseUrl);
      const applied = applyAuth(metadata, connection.secrets, url, {
        'user-agent': 'FlowForge/1.0',
      });
      const res = await this.egress.send({
        method,
        url: applied.url.toString(),
        headers: applied.headers,
        timeoutMs: TEST_TIMEOUT_MS,
        maxRedirects: 3,
        maxResponseBytes: 1_024,
        sensitiveHeaders: applied.sensitiveHeaders,
        checkHop: (hop) => {
          if (!hostAllowed(hop.hostname.replace(/^\[|\]$/g, ''), metadata.allowedHosts)) {
            throw new EgressBlockedError("host is not in the connection's allowed hosts");
          }
        },
      });
      const failure = classifyStatus(res, { idempotent: true, failOn4xx: true });
      return {
        ok: !failure,
        status: res.status,
        durationMs: res.durationMs,
        ...(failure && { category: failure.category, message: failure.message }),
      };
    } catch (err) {
      const classified: ExecutionError = classifyTransportError(err, true);
      this.logger.info(
        { connectionId, category: classified.category },
        'HTTP connection test failed',
      );
      return { ok: false, category: classified.category, message: classified.message };
    }
  }

  private assertAvailable(): void {
    if (!this.config.http.enabled) {
      throw new ServiceUnavailableException('HTTP connections are disabled on this server');
    }
    if (!this.encryption.isConfigured()) {
      throw new ServiceUnavailableException(
        'Credential encryption is not configured on this server',
      );
    }
  }

  private parseCredentials(raw: unknown) {
    const parsed = httpCredentialsSchema.safeParse(raw);
    if (!parsed.success) {
      throw new UnprocessableEntityException({
        message: 'Invalid credentials',
        // Paths and messages only: never echo submitted values.
        details: parsed.error.issues.map((i) => ({
          path: ['credentials', ...i.path].join('.'),
          message: i.message,
        })),
      });
    }
    return parsed.data;
  }

  /** Validates base URL (egress policy, static part) and host allow-list. */
  private settings(
    baseUrl: string | null | undefined,
    allowedHosts: string[] | null | undefined,
  ): Pick<HttpConnectionMetadata, 'baseUrl' | 'allowedHosts'> {
    let base: string | undefined;
    if (baseUrl) {
      try {
        const checked = checkUrl(baseUrl, this.config.http.policy);
        if (checked.url.search || checked.url.hash)
          throw new EgressBlockedError('no query or fragment in a base URL');
        base = checked.url.toString();
      } catch (err) {
        throw new UnprocessableEntityException({
          message: 'Invalid base URL',
          details: [{ path: 'baseUrl', message: err instanceof Error ? err.message : 'invalid' }],
        });
      }
    }
    let hosts: string[] | undefined;
    if (allowedHosts?.length) {
      const parsed = z.array(allowedHostSchema).max(20).safeParse(allowedHosts);
      if (!parsed.success) {
        throw new UnprocessableEntityException({
          message: 'Invalid allowed hosts',
          details: parsed.error.issues.map((i) => ({
            path: ['allowedHosts', ...i.path].join('.'),
            message: i.message,
          })),
        });
      }
      hosts = [...new Set(parsed.data)];
      if (base && !hostAllowed(new URL(base).hostname, hosts)) {
        throw new UnprocessableEntityException({
          message: 'The base URL host must be one of the allowed hosts',
          details: [{ path: 'baseUrl', message: 'host not in allowedHosts' }],
        });
      }
    }
    return { baseUrl: base, allowedHosts: hosts };
  }

  private async find(workspaceId: string, connectionId: string) {
    const connection = await this.prisma.integrationConnection.findFirst({
      where: { id: connectionId, workspaceId, provider: IntegrationProviderKey.HTTP },
      select: { id: true, metadata: true },
    });
    if (!connection) throw new NotFoundException('Connection not found');
    return connection;
  }
}

const stripUndefined = (value: object) =>
  JSON.parse(JSON.stringify(value)) as Prisma.InputJsonObject;
