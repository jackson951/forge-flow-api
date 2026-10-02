import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseEnumPipe,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiFoundResponse,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';
import { IntegrationProviderKey } from '@prisma/client';
import { Response } from 'express';
import { CurrentWorkspace, Public, RequireRole } from '../../common/decorators';
import { WorkspaceAccess } from '../../common/interfaces/workspace-access.interface';
import { SlackChannelsQueryDto } from './dto/slack-channels-query.dto';
import { IntegrationsService } from './integrations.service';

const providerPipe = new ParseEnumPipe(IntegrationProviderKey);

/** Workspace-scoped connection management. Responses never include credentials. */
@ApiTags('Integrations')
@ApiBearerAuth()
@Controller('workspaces/:workspaceId/integrations')
export class IntegrationsController {
  constructor(private readonly integrations: IntegrationsService) {}

  @Get()
  connections(@CurrentWorkspace() ws: WorkspaceAccess) {
    return this.integrations.listConnections(ws.workspaceId);
  }

  /** Returns the provider URL to send the browser to. */
  @RequireRole('ADMIN')
  @ApiServiceUnavailableResponse({ description: 'Provider not configured on this server' })
  @Post(':provider/connect')
  connect(
    @CurrentWorkspace() ws: WorkspaceAccess,
    @Param('provider', providerPipe) provider: IntegrationProviderKey,
  ) {
    return this.integrations.startConnect(ws, provider);
  }

  /** Repositories the GitHub App installation can access (for trigger configuration). */
  @Get(':connectionId/github/repositories')
  repositories(
    @CurrentWorkspace() ws: WorkspaceAccess,
    @Param('connectionId', ParseUUIDPipe) connectionId: string,
  ) {
    return this.integrations.listGitHubRepositories(ws.workspaceId, connectionId);
  }

  /** Slack channels the bot can post to (for action configuration). IDs and names only. */
  @Get(':connectionId/slack/channels')
  slackChannels(
    @CurrentWorkspace() ws: WorkspaceAccess,
    @Param('connectionId', ParseUUIDPipe) connectionId: string,
    @Query() query: SlackChannelsQueryDto,
  ) {
    return this.integrations.listSlackChannels(
      ws.workspaceId,
      connectionId,
      query.cursor,
      query.limit,
    );
  }

  @RequireRole('ADMIN')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Delete(':connectionId')
  disconnect(
    @CurrentWorkspace() ws: WorkspaceAccess,
    @Param('connectionId', ParseUUIDPipe) connectionId: string,
  ) {
    return this.integrations.disconnect(ws, connectionId);
  }
}

/** Provider-level routes that are not tied to a workspace in the URL. */
@ApiTags('Integrations')
@Controller('integrations')
export class IntegrationProvidersController {
  constructor(private readonly integrations: IntegrationsService) {}

  @ApiBearerAuth()
  @Get('providers')
  providers() {
    return this.integrations.listProviders();
  }

  /**
   * OAuth / installation redirect target. Authenticated by the single-use `state` (bound to
   * user, workspace and provider), not by a bearer token. Always redirects to the frontend.
   */
  @Public()
  @ApiFoundResponse({ description: 'Redirect to FRONTEND_URL/integrations?provider=…&status=…' })
  @Get(':provider/callback')
  async callback(
    @Param('provider') provider: string,
    @Query() query: Record<string, unknown>,
    @Res() res: Response,
  ): Promise<void> {
    const strings = Object.fromEntries(
      Object.entries(query).map(([k, v]) => [
        k,
        typeof v === 'string' ? v.slice(0, 2_000) : undefined,
      ]),
    );
    res.redirect(HttpStatus.FOUND, await this.integrations.handleCallback(provider, strings));
  }
}
