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
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IntegrationProviderKey } from '@prisma/client';
import { CurrentWorkspace, Public, RequireRole } from '../../common/decorators';
import { WorkspaceAccess } from '../../common/interfaces/workspace-access.interface';
import { OAuthCallbackQueryDto } from './dto/oauth-callback-query.dto';
import { IntegrationsService } from './integrations.service';

const providerPipe = new ParseEnumPipe(IntegrationProviderKey);

/** Workspace-scoped connection management. Handlers arrive in Parts 10–17. */
@ApiTags('Integrations')
@ApiBearerAuth()
@Controller('workspaces/:workspaceId/integrations')
export class IntegrationsController {
  constructor(private readonly integrations: IntegrationsService) {}

  @Get()
  connections(@CurrentWorkspace() ws: WorkspaceAccess) {
    return this.integrations.listConnections(ws.workspaceId);
  }

  @RequireRole('ADMIN')
  @Post(':provider/connect')
  connect(
    @CurrentWorkspace() ws: WorkspaceAccess,
    @Param('provider', providerPipe) provider: IntegrationProviderKey,
  ) {
    return this.integrations.startConnect(ws.workspaceId, provider);
  }

  @RequireRole('ADMIN')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Delete(':connectionId')
  disconnect(
    @CurrentWorkspace() ws: WorkspaceAccess,
    @Param('connectionId', ParseUUIDPipe) connectionId: string,
  ) {
    return this.integrations.disconnect(ws.workspaceId, connectionId);
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
   * OAuth redirect target. Authenticated by the single-use `state` (bound to user, workspace
   * and provider), not by a bearer token or the URL.
   */
  @Public()
  @Get(':provider/callback')
  callback(
    @Param('provider', providerPipe) provider: IntegrationProviderKey,
    @Query() query: OAuthCallbackQueryDto,
  ) {
    return this.integrations.handleCallback(provider, query);
  }
}
