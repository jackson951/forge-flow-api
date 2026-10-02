import { IsOptional, IsString, MaxLength } from 'class-validator';
import { PaginationQueryDto } from '../../../common/dto/pagination-query.dto';

/** `cursor` is Slack's opaque `next_cursor`, passed through unchanged. */
export class SlackChannelsQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  declare cursor?: string;
}
