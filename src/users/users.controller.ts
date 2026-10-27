import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { UserActor } from '../auth/actor';
import { CurrentUser, RequirePermissions } from '../auth/decorators';
import { Permission } from '../auth/permissions';
import { UserStatus } from '../generated/prisma/client';
import { CreateUserDto, ResetPasswordDto, SetGroupScopesDto, UpdateUserDto, UserQueryDto } from './users.dto';
import { UsersService } from './users.service';

@ApiTags('Users')
@ApiBearerAuth()
@RequirePermissions(Permission.USERS_MANAGE)
@Controller({ path: 'users', version: '1' })
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Post()
  create(@Body() dto: CreateUserDto, @CurrentUser() actor: UserActor) {
    return this.users.create(dto, actor);
  }

  @Get()
  list(@Query() q: UserQueryDto) {
    return this.users.list(q);
  }

  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.users.get(id);
  }

  @Patch(':id')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateUserDto, @CurrentUser() actor: UserActor) {
    return this.users.update(id, dto, actor);
  }

  /** Disabling also revokes all of the user's refresh tokens; access is refused immediately. */
  @Post(':id/disable')
  @HttpCode(HttpStatus.OK)
  disable(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() actor: UserActor) {
    return this.users.setStatus(id, UserStatus.DISABLED, actor);
  }

  @Post(':id/enable')
  @HttpCode(HttpStatus.OK)
  enable(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() actor: UserActor) {
    return this.users.setStatus(id, UserStatus.ACTIVE, actor);
  }

  /** Replace the set of CDS groups a CDS_ADMIN / LGI_VIEWER may access. */
  @Put(':id/group-scopes')
  setGroupScopes(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SetGroupScopesDto, @CurrentUser() actor: UserActor) {
    return this.users.setGroupScopes(id, dto.groupIds, actor);
  }

  @Post(':id/reset-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  async resetPassword(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ResetPasswordDto, @CurrentUser() actor: UserActor) {
    await this.users.resetPassword(id, dto.newPassword, actor);
  }
}
