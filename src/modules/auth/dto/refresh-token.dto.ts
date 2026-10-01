import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

/** The refresh token may come from this body field or from the HttpOnly cookie (preferred). */
export class RefreshTokenDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(512)
  refreshToken?: string;
}
