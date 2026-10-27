import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';

export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 128;

export class LoginDto {
  @IsEmail() @MaxLength(254)
  email: string;

  @IsString() @MinLength(1) @MaxLength(PASSWORD_MAX)
  password: string;
}

export class RefreshDto {
  @IsString() @MinLength(20) @MaxLength(200)
  refreshToken: string;
}

export class ChangePasswordDto {
  @IsString() @MinLength(1) @MaxLength(PASSWORD_MAX)
  currentPassword: string;

  @IsString() @MinLength(PASSWORD_MIN) @MaxLength(PASSWORD_MAX)
  newPassword: string;
}

export class TokenPairDto {
  accessToken: string;
  accessTokenExpiresIn: number;
  refreshToken: string;
  refreshTokenExpiresAt: string;
  tokenType: 'Bearer';
}
