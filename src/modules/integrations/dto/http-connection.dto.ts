import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';

const trim = () =>
  Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value));

const CREDENTIALS_DOC = {
  description:
    'Write-only secrets, by authType: bearer {token}; basic {username, password}; apiKeyHeader {headerName, value}; apiKeyQuery {paramName, value}; customHeaders {headers: {name: value}} (1–10). Never returned.',
  example: { authType: 'bearer', token: '<secret>' },
};

export class CreateHttpConnectionDto {
  @ApiProperty({ example: 'Billing API' })
  @trim()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name: string;

  @ApiProperty({ ...CREDENTIALS_DOC, type: 'object', additionalProperties: true })
  @IsObject()
  credentials: Record<string, unknown>;

  @ApiPropertyOptional({
    example: 'https://api.example.com/v1',
    description: 'Relative URLs in http.request steps resolve against it',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2_048)
  baseUrl?: string;

  @ApiPropertyOptional({
    example: ['api.example.com'],
    description: 'Credentials are only ever sent to these hosts',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  allowedHosts?: string[];
}

export class UpdateHttpConnectionDto {
  @ApiPropertyOptional({ example: 'Billing API (EU)' })
  @trim()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name?: string;

  @ApiPropertyOptional({ nullable: true, description: 'null removes the base URL' })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsString()
  @MaxLength(2_048)
  baseUrl?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    type: [String],
    description: 'null removes the restriction',
  })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  allowedHosts?: string[] | null;
}

export class RotateHttpCredentialsDto {
  @ApiProperty({ ...CREDENTIALS_DOC, type: 'object', additionalProperties: true })
  @IsObject()
  credentials: Record<string, unknown>;
}

export class TestHttpConnectionDto {
  @ApiProperty({
    example: 'https://api.example.com/v1/me',
    description: 'Absolute, or relative to the base URL',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(2_048)
  url: string;

  @ApiPropertyOptional({ enum: ['GET', 'HEAD'], default: 'GET' })
  @IsOptional()
  @IsIn(['GET', 'HEAD'])
  method?: 'GET' | 'HEAD';
}
