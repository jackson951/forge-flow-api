import { ApiProperty } from '@nestjs/swagger';
import { IsInt, Min } from 'class-validator';

export class PublishWorkflowDto {
  @ApiProperty({
    description: 'The draftRevision that was reviewed; publishing fails if the draft changed since',
  })
  @IsInt()
  @Min(0)
  expectedRevision: number;
}
