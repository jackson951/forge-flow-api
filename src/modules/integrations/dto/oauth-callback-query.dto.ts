import { IsOptional, IsString } from 'class-validator';

export class OAuthCallbackQueryDto {
  @IsString()
  code: string;

  @IsString()
  state: string;

  @IsOptional()
  @IsString()
  error?: string;
}
