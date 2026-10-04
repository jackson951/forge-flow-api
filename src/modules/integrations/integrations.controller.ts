import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseEnumPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Res,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  ApiBearerAuth,
  ApiFoundResponse,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiOperation,
} from '@nestjs/swagger';
import { IntegrationProviderKey } from '@prisma/client';
import { Response } from 'express';
import { CurrentWorkspace, Public, RequireRole } from '../../common/decorators';
import { WorkspaceAccess } from '../../common/interfaces/workspace-access.interface';
import {
  CreateHttpConnectionDto,
  RotateHttpCredentialsDto,
  TestHttpConnectionDto,
  UpdateHttpConnectionDto,
} from './dto/http-connection.dto';
import { SlackChannelsQueryDto } from './dto/slack-channels-query.dto';
import { JiraPickerQueryDto, JiraProjectPickerQueryDto } from './dto/jira-picker-query.dto';
import { HttpConnectionsService } from './http/http-connections.service';
import { byUserOrIp, MINUTE } from '../../common/throttling/rate-limits';
import { IntegrationsService } from './integrations.service';

const providerPipe = new ParseEnumPipe(IntegrationProviderKey);

/** Workspace-scoped connection management. Responses never include credentials. */
@ApiTags('Integrations')
@ApiBearerAuth()
@Controller('workspaces/:workspaceId/integrations')
export class IntegrationsController {
  constructor(
    private readonly integrations: IntegrationsService,
    private readonly http: HttpConnectionsService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Connected integration accounts of the workspace (no secrets)' })
  connections(@CurrentWorkspace() ws: WorkspaceAccess) {
    return this.integrations.listConnections(ws.workspaceId);
  }

  /** Part 24: credential-based HTTP connection (no OAuth). Secrets are write-only. */
  @RequireRole('ADMIN')
  @ApiServiceUnavailableResponse({ description: 'HTTP connections or encryption not configured' })
  @Post('http')
  @ApiOperation({ summary: 'Create an HTTP connection (API key / bearer / basic) (ADMIN)' })
  createHttp(@CurrentWorkspace() ws: WorkspaceAccess, @Body() dto: CreateHttpConnectionDto) {
    return this.http.create(ws, dto);
  }

  /** One request through the egress guard; returns the outcome only, never the response. */
  @RequireRole('ADMIN')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: MINUTE, getTracker: byUserOrIp } })
  @Post(':connectionId/test')
  @ApiOperation({ summary: 'Test an HTTP connection against a URL (outcome only) (ADMIN)' })
  testHttp(
    @CurrentWorkspace() ws: WorkspaceAccess,
    @Param('connectionId', ParseUUIDPipe) connectionId: string,
    @Body() dto: TestHttpConnectionDto,
  ) {
    return this.http.test(ws, connectionId, dto);
  }

  @RequireRole('ADMIN')
  @Patch(':connectionId')
  @ApiOperation({
    summary: 'Rename an HTTP connection or change its base URL / allowed hosts (ADMIN)',
  })
  updateHttp(
    @CurrentWorkspace() ws: WorkspaceAccess,
    @Param('connectionId', ParseUUIDPipe) connectionId: string,
    @Body() dto: UpdateHttpConnectionDto,
  ) {
    return this.http.update(ws, connectionId, dto);
  }

  @RequireRole('ADMIN')
  @Put(':connectionId/credentials')
  @ApiOperation({ summary: 'Replace the secrets of an HTTP connection (write-only) (ADMIN)' })
  rotateHttp(
    @CurrentWorkspace() ws: WorkspaceAccess,
    @Param('connectionId', ParseUUIDPipe) connectionId: string,
    @Body() dto: RotateHttpCredentialsDto,
  ) {
    return this.http.rotate(ws, connectionId, dto.credentials);
  }

  /** Returns the provider URL to send the browser to. */
  @RequireRole('ADMIN')
  @ApiServiceUnavailableResponse({ description: 'Provider not configured on this server' })
  @Post(':provider/connect')
  @ApiOperation({
    summary: 'Start connecting a provider: returns the URL to send the browser to (ADMIN)',
  })
  connect(
    @CurrentWorkspace() ws: WorkspaceAccess,
    @Param('provider', providerPipe) provider: IntegrationProviderKey,
  ) {
    return this.integrations.startConnect(ws, provider);
  }

  /** Repositories the GitHub App installation can access (for trigger configuration). */
  @Get(':connectionId/github/repositories')
  @ApiOperation({ summary: 'Repositories the GitHub App installation can access' })
  repositories(
    @CurrentWorkspace() ws: WorkspaceAccess,
    @Param('connectionId', ParseUUIDPipe) connectionId: string,
  ) {
    return this.integrations.listGitHubRepositories(ws.workspaceId, connectionId);
  }

  /** Slack channels the bot can post to (for action configuration). IDs and names only. */
  @Get(':connectionId/slack/channels')
  @ApiOperation({ summary: 'Slack channels the bot can post to (ids and names only)' })
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

  /** Part 25: Jira pickers for the editor (minimal fields). */
  @Get(':connectionId/jira/sites')
  @ApiOperation({ summary: 'Jira sites the connection can use' })
  jiraSites(
    @CurrentWorkspace() ws: WorkspaceAccess,
    @Param('connectionId', ParseUUIDPipe) connectionId: string,
  ) {
    return this.integrations.listJiraSites(ws.workspaceId, connectionId);
  }

  @Get(':connectionId/jira/projects')
  @ApiOperation({ summary: 'Jira projects on a site (id, key, name)' })
  jiraProjects(
    @CurrentWorkspace() ws: WorkspaceAccess,
    @Param('connectionId', ParseUUIDPipe) connectionId: string,
    @Query() query: JiraPickerQueryDto,
  ) {
    return this.integrations.listJiraProjects(
      ws.workspaceId,
      connectionId,
      query.siteId,
      query.query,
    );
  }

  @Get(':connectionId/jira/issue-types')
  @ApiOperation({ summary: 'Issue types of a Jira project' })
  jiraIssueTypes(
    @CurrentWorkspace() ws: WorkspaceAccess,
    @Param('connectionId', ParseUUIDPipe) connectionId: string,
    @Query() query: JiraProjectPickerQueryDto,
  ) {
    return this.integrations.listJiraIssueTypes(
      ws.workspaceId,
      connectionId,
      query.siteId,
      query.project,
    );
  }

  @Get(':connectionId/jira/statuses')
  @ApiOperation({ summary: 'Statuses used in a Jira project' })
  jiraStatuses(
    @CurrentWorkspace() ws: WorkspaceAccess,
    @Param('connectionId', ParseUUIDPipe) connectionId: string,
    @Query() query: JiraProjectPickerQueryDto,
  ) {
    return this.integrations.listJiraStatuses(
      ws.workspaceId,
      connectionId,
      query.siteId,
      query.project,
    );
  }

  @Get(':connectionId/jira/users')
  @ApiOperation({ summary: 'Assignable users of a Jira project (account id, display name)' })
  jiraUsers(
    @CurrentWorkspace() ws: WorkspaceAccess,
    @Param('connectionId', ParseUUIDPipe) connectionId: string,
    @Query() query: JiraProjectPickerQueryDto,
  ) {
    return this.integrations.listJiraUsers(
      ws.workspaceId,
      connectionId,
      query.siteId,
      query.project,
      query.query,
    );
  }

  /** Microsoft To Do lists of the connecting user (for action configuration). */
  @Get(':connectionId/microsoft/todo-lists')
  @ApiOperation({ summary: 'Microsoft To Do lists of the connected account' })
  todoLists(
    @CurrentWorkspace() ws: WorkspaceAccess,
    @Param('connectionId', ParseUUIDPipe) connectionId: string,
  ) {
    return this.integrations.listMicrosoftTodoLists(ws.workspaceId, connectionId);
  }

  @RequireRole('ADMIN')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Delete(':connectionId')
  @ApiOperation({
    summary: 'Disconnect an integration (revokes provider tokens where supported) (ADMIN)',
  })
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
  @ApiOperation({
    summary: 'Integration providers and whether this deployment has them configured',
  })
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
  @ApiOperation({
    summary: 'OAuth / installation redirect target (authenticated by the single-use state)',
  })
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
