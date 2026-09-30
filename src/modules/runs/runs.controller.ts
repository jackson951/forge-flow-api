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
import { CurrentUser } from '../../common/decorators';
import { AuthenticatedUser } from '../../common/interfaces/authenticated-user.interface';
import { ListRunsQueryDto } from './dto/list-runs-query.dto';
import { RunsService } from './runs.service';

@ApiTags('Runs')
@ApiBearerAuth()
@Controller('runs')
export class RunsController {
  constructor(private readonly runs: RunsService) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: ListRunsQueryDto) {
    return this.runs.list(user.workspaceId, query);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.runs.get(user.workspaceId, id);
  }

  @HttpCode(HttpStatus.ACCEPTED)
  @Post(':id/retry')
  retry(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.runs.retry(user.workspaceId, id);
  }

  @HttpCode(HttpStatus.OK)
  @Post(':id/cancel')
  cancel(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.runs.cancel(user.workspaceId, id);
  }
}
