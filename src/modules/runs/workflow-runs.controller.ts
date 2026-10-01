import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiHeader,
  ApiTags,
} from '@nestjs/swagger';
import { Request } from 'express';
import { CurrentWorkspace } from '../../common/decorators';
import { WorkspaceAccess } from '../../common/interfaces/workspace-access.interface';
import { ManualRunDto, MAX_MANUAL_INPUT_BYTES } from './dto/manual-run.dto';
import { DispatchedRun, RunDispatcherService } from './run-dispatcher.service';

const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{1,128}$/;

@ApiTags('Runs')
@ApiBearerAuth()
@Controller('workspaces/:workspaceId/workflows/:workflowId/runs')
export class WorkflowRunsController {
  constructor(private readonly dispatcher: RunDispatcherService) {}

  /** Queues a run of the active version. Returns immediately; a worker executes it. */
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiHeader({
    name: 'Idempotency-Key',
    required: false,
    description: 'Retries with the same key return the same run',
  })
  @ApiAcceptedResponse({ description: '{ runId, status }' })
  @ApiConflictResponse({ description: 'Not published, archived, or not manually triggerable' })
  @Post()
  start(
    @CurrentWorkspace() ws: WorkspaceAccess,
    @Param('workflowId', ParseUUIDPipe) workflowId: string,
    @Body() dto: ManualRunDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() req: Request & { id?: string },
  ): Promise<DispatchedRun> {
    if (idempotencyKey !== undefined && !IDEMPOTENCY_KEY.test(idempotencyKey)) {
      throw new BadRequestException('Idempotency-Key must be 1–128 characters of [A-Za-z0-9._:-]');
    }
    const input = dto.input ?? {};
    if (Buffer.byteLength(JSON.stringify(input), 'utf8') > MAX_MANUAL_INPUT_BYTES) {
      throw new BadRequestException(`input must not exceed ${MAX_MANUAL_INPUT_BYTES / 1024} KB`);
    }
    return this.dispatcher.createManualRun({
      workspaceId: ws.workspaceId,
      workflowId,
      input,
      idempotencyKey,
      correlationId: req.id,
    });
  }
}
