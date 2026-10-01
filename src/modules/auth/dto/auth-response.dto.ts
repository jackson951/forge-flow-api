import { ApiProperty } from '@nestjs/swagger';

export class UserResponseDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty() email: string;
  @ApiProperty() name: string;
  @ApiProperty() createdAt: Date;
}

export class TokenResponseDto {
  @ApiProperty() accessToken: string;
  @ApiProperty({ description: 'Also set as an HttpOnly cookie' }) refreshToken: string;
  @ApiProperty({ description: 'Access-token lifetime in seconds' }) expiresIn: number;
}

export class AuthResponseDto extends TokenResponseDto {
  @ApiProperty({ type: UserResponseDto }) user: UserResponseDto;
}
