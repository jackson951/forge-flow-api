import { IsDateString, IsEnum, IsOptional, IsUUID } from 'class-validator';
import { RunStatus } from '@prisma/client';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';

export class ListRunsQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsUUID()
  workflowId?: string;

  @IsOptional()
  @IsEnum(RunStatus)
  status?: RunStatus;

  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;
}
