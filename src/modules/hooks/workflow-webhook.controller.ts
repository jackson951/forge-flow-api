import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { CurrentWorkspace, RequireRole } from '../../common/decorators';
import { WorkspaceAccess } from '../../common/interfaces/workspace-access.interface';
import {
  HookDeliveriesQueryDto,
  RotateHookSecretDto,
  RotateHookUrlDto,
} from './dto/hook-admin.dto';
import { HookAdminService } from './hook-admin.service';

const baseUrl = (req: Request) => `${req.protocol}://${req.get('host') ?? 'localhost'}`;

/** A workflow's generic webhook (Part 24): URL, rotation, delivery log, replay, test capture. */
@ApiTags('Workflows')
@ApiBearerAuth()
@Controller('workspaces/:workspaceId/workflows/:workflowId/webhook')
export class WorkflowWebhookController {
  constructor(private readonly hooks: HookAdminService) {}

  @Get()
  @ApiOperation({
    summary: 'Webhook URL, status and secret hint (a generated secret is shown once, to an admin)',
  })
  details(
    @CurrentWorkspace() ws: WorkspaceAccess,
    @Param('workflowId', ParseUUIDPipe) workflowId: string,
    @Req() req: Request,
  ) {
    return this.hooks.details(ws, workflowId, baseUrl(req));
  }

  @RequireRole('ADMIN')
  @HttpCode(HttpStatus.OK)
  @Post('rotate-secret')
  @ApiOperation({
    summary: 'New webhook secret; the old one stays valid for a grace period (ADMIN)',
  })
  rotateSecret(
    @CurrentWorkspace() ws: WorkspaceAccess,
    @Param('workflowId', ParseUUIDPipe) workflowId: string,
    @Body() dto: RotateHookSecretDto,
  ) {
    return this.hooks.rotateSecret(ws, workflowId, dto);
  }

  @RequireRole('ADMIN')
  @HttpCode(HttpStatus.OK)
  @Post('rotate-url')
  @ApiOperation({
    summary: 'New webhook URL; the old one keeps working for a grace period (ADMIN)',
  })
  rotateUrl(
    @CurrentWorkspace() ws: WorkspaceAccess,
    @Param('workflowId', ParseUUIDPipe) workflowId: string,
    @Body() dto: RotateHookUrlDto,
    @Req() req: Request,
  ) {
    return this.hooks.rotateUrl(ws, workflowId, dto, baseUrl(req));
  }

  @Get('deliveries')
  @ApiOperation({ summary: 'Recent webhook deliveries: status, reason, size, run (no secrets)' })
  deliveries(
    @CurrentWorkspace() ws: WorkspaceAccess,
    @Param('workflowId', ParseUUIDPipe) workflowId: string,
    @Query() query: HookDeliveriesQueryDto,
  ) {
    return this.hooks.deliveries(ws, workflowId, query.limit, query.cursor);
  }

  @RequireRole('ADMIN')
  @HttpCode(HttpStatus.ACCEPTED)
  @Post('deliveries/:deliveryId/replay')
  @ApiOperation({ summary: 'Start a new run from a stored webhook delivery (ADMIN)' })
  replay(
    @CurrentWorkspace() ws: WorkspaceAccess,
    @Param('workflowId', ParseUUIDPipe) workflowId: string,
    @Param('deliveryId', ParseUUIDPipe) deliveryId: string,
    @Req() req: Request & { id?: string },
  ) {
    return this.hooks.replay(ws, workflowId, deliveryId, req.id);
  }

  @HttpCode(HttpStatus.OK)
  @Post('listen')
  @ApiOperation({
    summary: 'Capture the next delivery to this (unpublished) webhook for 10 minutes',
  })
  listen(
    @CurrentWorkspace() ws: WorkspaceAccess,
    @Param('workflowId', ParseUUIDPipe) workflowId: string,
    @Req() req: Request,
  ) {
    return this.hooks.listen(ws, workflowId, baseUrl(req));
  }

  @Get('listen')
  @ApiOperation({ summary: 'The captured test delivery, if one arrived' })
  captured(
    @CurrentWorkspace() ws: WorkspaceAccess,
    @Param('workflowId', ParseUUIDPipe) workflowId: string,
  ) {
    return this.hooks.captured(ws, workflowId);
  }
}
