import { ApiProperty } from '@nestjs/swagger';
import { WorkspaceRole } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsString, MaxLength, MinLength } from 'class-validator';

const trim = () =>
  Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value));

export class CreateWorkspaceDto {
  @ApiProperty({ example: 'Platform team' })
  @trim()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name: string;
}

export class UpdateWorkspaceDto extends CreateWorkspaceDto {}

export class WorkspaceResponseDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty() name: string;
  @ApiProperty({ enum: WorkspaceRole, description: "The caller's role" }) role: WorkspaceRole;
  @ApiProperty() createdAt: Date;
  @ApiProperty() updatedAt: Date;
}
