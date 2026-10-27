import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { UserActor } from '../auth/actor';
import { CurrentUser, RequirePermissions } from '../auth/decorators';
import { Permission } from '../auth/permissions';
import { GroupStatus } from '../generated/prisma/client';
import { CreateGroupDto, GroupQueryDto, UpdateGroupDto } from './groups.dto';
import { GroupsService } from './groups.service';

@ApiTags('Groups')
@ApiBearerAuth()
@Controller({ path: 'groups', version: '1' })
export class GroupsController {
  constructor(private readonly groups: GroupsService) {}

  @Post()
  @RequirePermissions(Permission.GROUPS_CREATE)
  create(@Body() dto: CreateGroupDto, @CurrentUser() user: UserActor) {
    return this.groups.create(dto, user);
  }

  @Get()
  @RequirePermissions(Permission.GROUPS_READ)
  list(@Query() q: GroupQueryDto, @CurrentUser() user: UserActor) {
    return this.groups.list(q, user.scope);
  }

  @Get(':id')
  @RequirePermissions(Permission.GROUPS_READ)
  get(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: UserActor) {
    return this.groups.get(id, user.scope);
  }

  @Patch(':id')
  @RequirePermissions(Permission.GROUPS_UPDATE)
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateGroupDto, @CurrentUser() user: UserActor) {
    return this.groups.update(id, dto, user);
  }

  @Post(':id/deactivate')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(Permission.GROUPS_CREATE)
  deactivate(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: UserActor) {
    return this.groups.setStatus(id, GroupStatus.INACTIVE, user);
  }

  @Post(':id/activate')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(Permission.GROUPS_CREATE)
  activate(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: UserActor) {
    return this.groups.setStatus(id, GroupStatus.ACTIVE, user);
  }
}
