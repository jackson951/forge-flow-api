import { IsDateString, IsEnum, IsOptional, IsUUID } from 'class-validator';
import { RunStatus, TriggerSource } from '@prisma/client';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';

/** Newest first; `cursor` is the opaque `nextCursor` of the previous page; limit ≤ 100. */
export class ListRunsQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsUUID()
  workflowId?: string;

  @IsOptional()
  @IsEnum(RunStatus)
  status?: RunStatus;

  @IsOptional()
  @IsEnum(TriggerSource)
  triggerSource?: TriggerSource;

  /** Created at or after (ISO 8601). */
  @IsOptional()
  @IsDateString()
  from?: string;

  /** Created before (ISO 8601). */
  @IsOptional()
  @IsDateString()
  to?: string;
}
