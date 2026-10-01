import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsObject, IsOptional } from 'class-validator';

export class ValidateDefinitionDto {
  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: true,
    description: 'Definition to check without saving; defaults to the stored draft',
  })
  @IsOptional()
  @IsObject()
  definition?: Record<string, unknown>;
}
