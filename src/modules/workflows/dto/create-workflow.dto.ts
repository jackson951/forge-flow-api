import { IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateWorkflowDto {
  @IsString()
  @MaxLength(120)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;
}
