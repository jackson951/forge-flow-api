import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';
import { NormalizeEmail, Trim } from './normalize';

export class RegisterDto {
  @ApiProperty({ example: 'ada@example.com' })
  @NormalizeEmail()
  @IsEmail()
  @MaxLength(254)
  email: string;

  @ApiProperty({ minLength: 12, maxLength: 128 })
  @IsString()
  @MinLength(12)
  @MaxLength(128)
  password: string;

  @ApiProperty({ example: 'Ada Lovelace' })
  @Trim()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name: string;
}
