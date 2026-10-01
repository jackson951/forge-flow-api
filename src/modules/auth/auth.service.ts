import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Prisma, WorkspaceRole } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { PublicUser, toPublicUser, UsersService } from '../users/users.service';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';

export interface ClientMeta {
  userAgent?: string;
  ip?: string;
}

export interface SessionTokens {
  accessToken: string;
  refreshToken: string;
  /** Access-token lifetime in seconds. */
  expiresIn: number;
}

export interface AuthResult extends SessionTokens {
  user: PublicUser;
}

const INVALID_CREDENTIALS = 'Invalid email or password';
const INVALID_REFRESH = 'Invalid or expired refresh token';

/**
 * A rotated token presented within this window is treated as a lost race, not as theft:
 * it is rejected without revoking the family. Replays after the window revoke the family.
 * Either way the presenter never receives tokens.
 */
export const REUSE_GRACE_MS = 10_000;

type RotationOutcome =
  | { kind: 'rotated'; userId: string; tokens: SessionTokens }
  | { kind: 'reuse'; userId: string; familyId: string }
  | { kind: 'invalid' };

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly users: UsersService,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly audit: AuditService,
  ) {}

  /** Creates the user, a personal workspace (OWNER) and a session, atomically for the data. */
  async register(dto: RegisterDto, meta: ClientMeta): Promise<AuthResult> {
    const passwordHash = await this.passwords.hash(dto.password);
    try {
      const user = await this.prisma.$transaction(async (tx) => {
        const created = await tx.user.create({
          data: { email: dto.email, name: dto.name, passwordHash },
        });
        const workspace = await tx.workspace.create({
          data: {
            name: `${dto.name}'s workspace`,
            members: { create: { userId: created.id, role: WorkspaceRole.OWNER } },
          },
        });
        await this.audit.record(
          { action: 'auth.register', actorUserId: created.id, workspaceId: workspace.id },
          tx,
        );
        return created;
      });
      return { user: toPublicUser(user), ...(await this.startSession(user.id, meta)) };
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException('An account with this email already exists');
      }
      throw err;
    }
  }

  async login(dto: LoginDto, meta: ClientMeta): Promise<AuthResult> {
    const user = await this.users.findByEmailWithCredentials(dto.email);
    const valid = user
      ? await this.passwords.verify(user.passwordHash, dto.password)
      : await this.passwords.verifyAgainstDummy(dto.password);

    if (!user || !valid) {
      await this.audit.record({
        action: 'auth.login.failed',
        actorUserId: user?.id ?? null,
        metadata: { emailHash: sha256(dto.email), knownUser: Boolean(user) },
      });
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }
    return { user: toPublicUser(user), ...(await this.startSession(user.id, meta)) };
  }

  /**
   * Rotation with reuse detection: a valid token is revoked and replaced by a new one in the
   * same family. Presenting a token that was already rotated means it leaked (or a client is
   * replaying it), so the whole family is revoked.
   */
  async refresh(rawToken: string | undefined, meta: ClientMeta): Promise<SessionTokens> {
    if (!rawToken) throw new UnauthorizedException(INVALID_REFRESH);
    const tokenHash = this.tokens.hashRefreshToken(rawToken);

    const outcome = await this.prisma.$transaction(async (tx): Promise<RotationOutcome> => {
      const current = await tx.refreshToken.findUnique({ where: { tokenHash } });
      if (!current) return { kind: 'invalid' };

      if (current.replacedById) {
        // Just rotated: most likely a concurrent request (second tab, client retry) that lost
        // the race. Reject it without punishing the legitimate client.
        if (current.revokedAt && Date.now() - current.revokedAt.getTime() < REUSE_GRACE_MS) {
          return { kind: 'invalid' };
        }
        await revokeFamily(tx, current.familyId);
        return { kind: 'reuse', userId: current.userId, familyId: current.familyId };
      }
      if (current.revokedAt || current.expiresAt <= new Date()) return { kind: 'invalid' };

      // Conditional claim: of two concurrent refreshes with the same token, only one wins.
      const claimed = await tx.refreshToken.updateMany({
        where: { id: current.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      if (claimed.count === 0) return { kind: 'invalid' };

      const next = this.tokens.generateRefreshToken();
      const created = await tx.refreshToken.create({
        data: this.refreshTokenData(current.userId, current.familyId, next.hash, meta),
      });
      await tx.refreshToken.update({
        where: { id: current.id },
        data: { replacedById: created.id },
      });
      return {
        kind: 'rotated',
        userId: current.userId,
        tokens: this.sessionTokens(current.userId, next.token),
      };
    });

    if (outcome.kind === 'rotated') return outcome.tokens;
    if (outcome.kind === 'reuse') {
      await this.audit.record({
        action: 'auth.refresh.reuse_detected',
        actorUserId: outcome.userId,
        metadata: { familyId: outcome.familyId },
      });
    }
    throw new UnauthorizedException(INVALID_REFRESH);
  }

  /** Ends the session the refresh token belongs to. Idempotent; unknown tokens are ignored. */
  async logout(rawToken: string | undefined): Promise<void> {
    if (!rawToken) return;
    const token = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: this.tokens.hashRefreshToken(rawToken) },
    });
    if (token) await revokeFamily(this.prisma, token.familyId);
  }

  async logoutAll(userId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await this.audit.record({ action: 'auth.logout_all', actorUserId: userId });
  }

  async me(userId: string): Promise<PublicUser> {
    const user = await this.users.findPublicById(userId);
    if (!user) throw new UnauthorizedException();
    return user;
  }

  private async startSession(userId: string, meta: ClientMeta): Promise<SessionTokens> {
    const refresh = this.tokens.generateRefreshToken();
    await this.prisma.refreshToken.create({
      data: this.refreshTokenData(userId, randomUUID(), refresh.hash, meta),
    });
    return this.sessionTokens(userId, refresh.token);
  }

  private sessionTokens(userId: string, refreshToken: string): SessionTokens {
    return {
      accessToken: this.tokens.issueAccessToken(userId),
      refreshToken,
      expiresIn: this.tokens.accessTokenTtlSeconds,
    };
  }

  private refreshTokenData(
    userId: string,
    familyId: string,
    tokenHash: string,
    meta: ClientMeta,
  ): Prisma.RefreshTokenUncheckedCreateInput {
    return {
      userId,
      familyId,
      tokenHash,
      expiresAt: new Date(Date.now() + this.tokens.refreshTokenTtlMs),
      userAgent: meta.userAgent?.slice(0, 255),
      ipHash: meta.ip ? sha256(meta.ip) : undefined,
    };
  }
}

function revokeFamily(db: Prisma.TransactionClient, familyId: string) {
  return db.refreshToken.updateMany({
    where: { familyId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
