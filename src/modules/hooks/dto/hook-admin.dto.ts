import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';

export class RotateHookSecretDto {
  @ApiPropertyOptional({
    description:
      "The sender's own secret (e.g. one a provider generated). Omitted: FlowForge generates one and returns it once.",
  })
  @IsOptional()
  @IsString()
  @MinLength(16)
  @MaxLength(256)
  secret?: string;

  @ApiPropertyOptional({
    description: 'Hours the previous secret stays valid (default 24, 0 = none)',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(168)
  graceHours?: number;
}

export class RotateHookUrlDto {
  @ApiPropertyOptional({
    description: 'Hours the previous URL keeps working (default 24, 0 = none)',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(168)
  graceHours?: number;
}

/** `cursor`: the id of the last delivery of the previous page. */
export class HookDeliveriesQueryDto extends PaginationQueryDto {}
