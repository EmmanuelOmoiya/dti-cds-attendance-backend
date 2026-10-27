import { ArrayMaxSize, IsArray, IsEmail, IsEnum, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { PASSWORD_MAX, PASSWORD_MIN } from '../auth/auth.dto';
import { PageQueryDto } from '../common/http/pagination';
import { Role, UserStatus } from '../generated/prisma/client';

export class CreateUserDto {
  @IsEmail() @MaxLength(254)
  email: string;

  @IsString() @MinLength(2) @MaxLength(120)
  fullName: string;

  @IsEnum(Role)
  role: Role;

  /** Initial password (min 10 chars). The user should change it after first login. */
  @IsString() @MinLength(PASSWORD_MIN) @MaxLength(PASSWORD_MAX)
  password: string;

  /** Groups a CDS_ADMIN / LGI_VIEWER may access. Ignored for SUPER_ADMIN. */
  @IsOptional() @IsArray() @ArrayMaxSize(100) @IsUUID('all', { each: true })
  groupIds?: string[];
}

export class UpdateUserDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(120)
  fullName?: string;

  @IsOptional() @IsEnum(Role)
  role?: Role;
}

export class SetGroupScopesDto {
  @IsArray() @ArrayMaxSize(100) @IsUUID('all', { each: true })
  groupIds: string[];
}

export class ResetPasswordDto {
  @IsString() @MinLength(PASSWORD_MIN) @MaxLength(PASSWORD_MAX)
  newPassword: string;
}

export class UserQueryDto extends PageQueryDto {
  /** Matches email or full name (case-insensitive). */
  @IsOptional() @IsString() @MaxLength(100)
  q?: string;

  @IsOptional() @IsEnum(Role)
  role?: Role;

  @IsOptional() @IsEnum(UserStatus)
  status?: UserStatus;
}
