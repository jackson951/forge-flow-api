import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

const trim = () =>
  Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value));

export class CreateWorkflowDto {
  @ApiProperty({ example: 'Triage new GitHub issues' })
  @trim()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name: string;

  @ApiPropertyOptional()
  @trim()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;
}
