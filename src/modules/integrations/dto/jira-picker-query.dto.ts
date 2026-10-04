import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';

export class JiraPickerQueryDto {
  @ApiProperty({ description: 'Jira site (cloud id) from /jira/sites' })
  @IsString()
  @Matches(/^[A-Za-z0-9-]{1,64}$/)
  siteId: string;

  @ApiPropertyOptional({ description: 'Search text' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  query?: string;
}

export class JiraProjectPickerQueryDto extends JiraPickerQueryDto {
  @ApiProperty({ example: 'ENG', description: 'Project key or id' })
  @IsString()
  @Matches(/^([A-Z][A-Z0-9_]{1,9}|\d{1,12})$/)
  project: string;
}
