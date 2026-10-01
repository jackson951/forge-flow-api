import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsObject, Min } from 'class-validator';

/**
 * The definition's shape is validated with the engine's zod schema (field-level 400s),
 * graph rules are returned as issues. See docs/backend/05-WORKFLOW-MANAGEMENT.md.
 */
export class SaveDraftDto {
  @ApiProperty({ description: 'The draftRevision the client last saw (optimistic concurrency)' })
  @IsInt()
  @Min(0)
  expectedRevision: number;

  @ApiProperty({ type: 'object', additionalProperties: true })
  @IsObject()
  definition: Record<string, unknown>;
}
