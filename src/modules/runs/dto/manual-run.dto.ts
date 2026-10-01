import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsObject, IsOptional } from 'class-validator';

export const MAX_MANUAL_INPUT_BYTES = 64 * 1024;

export class ManualRunDto {
  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: true,
    description: 'Becomes the trigger output (available as `trigger.*`). Max 64 KB.',
  })
  @IsOptional()
  @IsObject()
  input?: Record<string, unknown>;
}
