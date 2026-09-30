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
import { CurrentUser, Public } from '../../common/decorators';
import { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface';
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
  connections(@CurrentUser() user: AuthenticatedUser) {
    return this.integrations.listConnections(user.workspaceId);
  }

  @Post(':provider/connect')
  connect(
    @CurrentUser() user: AuthenticatedUser,
    @Param('provider', providerPipe) provider: IntegrationProviderKey,
  ) {
    return this.integrations.startConnect(user.workspaceId, provider);
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
  disconnect(
    @CurrentUser() user: AuthenticatedUser,
    @Param('connectionId', ParseUUIDPipe) connectionId: string,
  ) {
    return this.integrations.disconnect(user.workspaceId, connectionId);
  }
}
