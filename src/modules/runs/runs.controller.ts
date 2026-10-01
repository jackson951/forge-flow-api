import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { pendingWorkspaceScope } from '../../common/utils/pending-workspace-scope';
import { ListRunsQueryDto } from './dto/list-runs-query.dto';
import { RunsService } from './runs.service';

@ApiTags('Runs')
@ApiBearerAuth()
@Controller('runs')
export class RunsController {
  constructor(private readonly runs: RunsService) {}

  @Get()
  list(@Query() query: ListRunsQueryDto) {
    return this.runs.list(pendingWorkspaceScope(), query);
  }

  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.runs.get(pendingWorkspaceScope(), id);
  }

  @HttpCode(HttpStatus.ACCEPTED)
  @Post(':id/retry')
  retry(@Param('id', ParseUUIDPipe) id: string) {
    return this.runs.retry(pendingWorkspaceScope(), id);
  }

  @HttpCode(HttpStatus.OK)
  @Post(':id/cancel')
  cancel(@Param('id', ParseUUIDPipe) id: string) {
    return this.runs.cancel(pendingWorkspaceScope(), id);
  }
}
