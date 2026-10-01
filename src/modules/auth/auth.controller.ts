import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req, Res } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiCreatedResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Request, Response } from 'express';
import { CurrentUser, Public } from '../../common/decorators';
import { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface';
import { AppConfigService } from '../../config/app-config.service';
import { PublicUser } from '../users/users.service';
import { AuthResult, AuthService, ClientMeta, SessionTokens } from './auth.service';
import { AuthResponseDto, TokenResponseDto, UserResponseDto } from './dto/auth-response.dto';
import { LoginDto } from './dto/login.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { RegisterDto } from './dto/register.dto';
import {
  clearRefreshCookie,
  readRefreshCookie,
  REFRESH_COOKIE,
  refreshCookieOptions,
} from './refresh-cookie';
import { TokenService } from './token.service';

const MINUTE = 60_000;

/** Login attempts are limited per (IP, email) pair, so one attacker can't lock out others. */
const ipAndEmail = (req: Record<string, unknown>): string => {
  const body = req.body as { email?: unknown } | undefined;
  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
  return `${String(req.ip)}|${email}`;
};

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  private readonly cookiePath: string;

  constructor(
    private readonly auth: AuthService,
    private readonly tokens: TokenService,
    config: AppConfigService,
  ) {
    this.cookiePath = `/${config.get('API_PREFIX')}/v1/auth`;
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: MINUTE } })
  @ApiCreatedResponse({ type: AuthResponseDto })
  @ApiConflictResponse({ description: 'Email already registered' })
  @ApiTooManyRequestsResponse()
  @Post('register')
  async register(
    @Body() dto: RegisterDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthResult> {
    return this.withCookie(res, await this.auth.register(dto, clientMeta(req)));
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: MINUTE, getTracker: ipAndEmail } })
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: AuthResponseDto })
  @ApiUnauthorizedResponse({ description: 'Invalid email or password' })
  @ApiTooManyRequestsResponse()
  @Post('login')
  async login(
    @Body() dto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthResult> {
    return this.withCookie(res, await this.auth.login(dto, clientMeta(req)));
  }

  @Public()
  @Throttle({ default: { limit: 30, ttl: MINUTE } })
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: TokenResponseDto })
  @ApiUnauthorizedResponse({ description: 'Missing, invalid, expired, revoked or reused token' })
  @Post('refresh')
  async refresh(
    @Body() dto: RefreshTokenDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SessionTokens> {
    const raw = readRefreshCookie(req) ?? dto.refreshToken;
    try {
      return this.withCookie(res, await this.auth.refresh(raw, clientMeta(req)));
    } catch (err) {
      clearRefreshCookie(res, this.cookiePath);
      throw err;
    }
  }

  @Public()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse({ description: 'Session ended (idempotent)' })
  @Post('logout')
  async logout(
    @Body() dto: RefreshTokenDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    await this.auth.logout(readRefreshCookie(req) ?? dto.refreshToken);
    clearRefreshCookie(res, this.cookiePath);
  }

  @ApiBearerAuth()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse({ description: 'All sessions of the user ended' })
  @Post('logout-all')
  async logoutAll(
    @CurrentUser() user: AuthenticatedUser,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    await this.auth.logoutAll(user.userId);
    clearRefreshCookie(res, this.cookiePath);
  }

  @ApiBearerAuth()
  @ApiOkResponse({ type: UserResponseDto })
  @Get('me')
  me(@CurrentUser() user: AuthenticatedUser): Promise<PublicUser> {
    return this.auth.me(user.userId);
  }

  private withCookie<T extends SessionTokens>(res: Response, result: T): T {
    res.cookie(
      REFRESH_COOKIE,
      result.refreshToken,
      refreshCookieOptions(this.cookiePath, this.tokens.refreshTokenTtlMs),
    );
    return result;
  }
}

function clientMeta(req: Request): ClientMeta {
  return { userAgent: req.get('user-agent'), ip: req.ip };
}
