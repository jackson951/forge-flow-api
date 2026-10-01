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
import { Public } from '../../common/decorators';
import { pendingWorkspaceScope } from '../../common/utils/pending-workspace-scope';
import { OAuthCallbackQueryDto } from './dto/oauth-callback-query.dto';
import { IntegrationsService } from './integrations.service';

const providerPipe = new ParseEnumPipe(IntegrationProviderKey);

@ApiTags('Integrations')
@ApiBearerAuth()
@Controller('integrations')
export class IntegrationsController {
  constructor(private readonly integrations: IntegrationsService) {}

  @Get('providers')
  providers() {
    return this.integrations.listProviders();
  }

  @Get()
  connections() {
    return this.integrations.listConnections(pendingWorkspaceScope());
  }

  @Post(':provider/connect')
  connect(@Param('provider', providerPipe) provider: IntegrationProviderKey) {
    return this.integrations.startConnect(pendingWorkspaceScope(), provider);
  }

  /** OAuth redirect target. Authenticated via the signed `state` param, not a bearer token. */
  @Public()
  @Get(':provider/callback')
  callback(
    @Param('provider', providerPipe) provider: IntegrationProviderKey,
    @Query() query: OAuthCallbackQueryDto,
  ) {
    return this.integrations.handleCallback(provider, query);
  }

  @HttpCode(HttpStatus.NO_CONTENT)
  @Delete(':connectionId')
  disconnect(@Param('connectionId', ParseUUIDPipe) connectionId: string) {
    return this.integrations.disconnect(pendingWorkspaceScope(), connectionId);
  }
}
