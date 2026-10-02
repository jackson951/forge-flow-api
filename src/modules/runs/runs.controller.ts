import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { Request } from 'express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentWorkspace, RequireRole } from '../../common/decorators';
import { WorkspaceAccess } from '../../common/interfaces/workspace-access.interface';
import { ListRunsQueryDto } from './dto/list-runs-query.dto';
import { RetryRunDto } from './dto/retry-run.dto';
import { RetriedRun, RunDispatcherService } from './run-dispatcher.service';
import { RunsService } from './runs.service';

/** Handlers arrive in Part 16; roles follow the Part 04 matrix. */
@ApiTags('Runs')
@ApiBearerAuth()
@Controller('workspaces/:workspaceId/runs')
export class RunsController {
  constructor(
    private readonly runs: RunsService,
    private readonly dispatcher: RunDispatcherService,
  ) {}

  @Get()
  list(@CurrentWorkspace() ws: WorkspaceAccess, @Query() query: ListRunsQueryDto) {
    return this.runs.list(ws.workspaceId, query);
  }

  @Get(':id')
  get(@CurrentWorkspace() ws: WorkspaceAccess, @Param('id', ParseUUIDPipe) id: string) {
    return this.runs.get(ws.workspaceId, id);
  }

  @RequireRole('ADMIN')
  @HttpCode(HttpStatus.ACCEPTED)
  @Post(':id/retry')
  retry(
    @CurrentWorkspace() ws: WorkspaceAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RetryRunDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() req: Request & { id?: string },
  ): Promise<RetriedRun> {
    if (idempotencyKey !== undefined && !/^[A-Za-z0-9._:-]{1,128}$/.test(idempotencyKey)) {
      throw new BadRequestException('Idempotency-Key must be 1–128 characters of [A-Za-z0-9._:-]');
    }
    return this.dispatcher.retryRun({
      workspaceId: ws.workspaceId,
      userId: ws.userId,
      runId: id,
      resumeFromFailedStep: dto.resumeFromFailedStep,
      acknowledgeUncertainOutcome: dto.acknowledgeUncertainOutcome,
      idempotencyKey,
      correlationId: req.id,
    });
  }

  @RequireRole('ADMIN')
  @HttpCode(HttpStatus.OK)
  @Post(':id/cancel')
  cancel(@CurrentWorkspace() ws: WorkspaceAccess, @Param('id', ParseUUIDPipe) id: string) {
    return this.runs.cancel(ws.workspaceId, id);
  }
}
