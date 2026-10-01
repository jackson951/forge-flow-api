import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createHmac, randomBytes } from 'node:crypto';
import { parseDurationMs } from '../../common/utils/duration';
import { AppConfigService } from '../../config/app-config.service';

const ACCESS_TOKEN_TYPE = 'access';

export interface AccessTokenClaims {
  userId: string;
}

export interface GeneratedRefreshToken {
  token: string;
  hash: string;
}

@Injectable()
export class TokenService {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: AppConfigService,
  ) {}

  get accessTokenTtlSeconds(): number {
    return parseDurationMs(this.config.get('JWT_ACCESS_TTL')) / 1000;
  }

  get refreshTokenTtlMs(): number {
    return parseDurationMs(this.config.get('JWT_REFRESH_TTL'));
  }

  issueAccessToken(userId: string): string {
    return this.jwt.sign(
      { typ: ACCESS_TOKEN_TYPE },
      {
        secret: this.config.get('JWT_ACCESS_SECRET'),
        algorithm: 'HS256',
        subject: userId,
        expiresIn: this.accessTokenTtlSeconds,
        issuer: this.config.get('JWT_ISSUER'),
        audience: this.config.get('JWT_AUDIENCE'),
      },
    );
  }

  /** Returns null for any invalid, expired, foreign or wrongly-typed token. */
  verifyAccessToken(token: string): AccessTokenClaims | null {
    try {
      const payload = this.jwt.verify<{ sub?: unknown; typ?: unknown }>(token, {
        secret: this.config.get('JWT_ACCESS_SECRET'),
        algorithms: ['HS256'],
        issuer: this.config.get('JWT_ISSUER'),
        audience: this.config.get('JWT_AUDIENCE'),
      });
      if (payload.typ !== ACCESS_TOKEN_TYPE || typeof payload.sub !== 'string') return null;
      return { userId: payload.sub };
    } catch {
      return null;
    }
  }

  /** Opaque 256-bit refresh token; only its keyed hash is stored. */
  generateRefreshToken(): GeneratedRefreshToken {
    const token = randomBytes(32).toString('base64url');
    return { token, hash: this.hashRefreshToken(token) };
  }

  /** HMAC with JWT_REFRESH_SECRET, so a leaked table alone cannot be matched to tokens. */
  hashRefreshToken(token: string): string {
    return createHmac('sha256', this.config.get('JWT_REFRESH_SECRET')).update(token).digest('hex');
  }
}
