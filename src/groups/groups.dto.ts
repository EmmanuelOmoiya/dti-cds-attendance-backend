import { IsEnum, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { PageQueryDto } from '../common/http/pagination';
import { GroupStatus } from '../generated/prisma/client';

export class CreateGroupDto {
  @IsString() @MinLength(2) @MaxLength(120)
  name: string;

  @IsOptional() @IsString() @MaxLength(1000)
  description?: string;
}

export class UpdateGroupDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(120)
  name?: string;

  @IsOptional() @IsString() @MaxLength(1000)
  description?: string;
}

export class GroupQueryDto extends PageQueryDto {
  @IsOptional() @IsString() @MaxLength(100)
  q?: string;

  @IsOptional() @IsEnum(GroupStatus)
  status?: GroupStatus;
}
