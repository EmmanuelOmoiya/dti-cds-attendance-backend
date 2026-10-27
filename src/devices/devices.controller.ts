import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { UserActor } from '../auth/actor';
import { CurrentUser, RequirePermissions } from '../auth/decorators';
import { Permission } from '../auth/permissions';
import { DeviceQueryDto, DeviceStatusChangeDto, RegisterDeviceDto, SyncEventQueryDto, UpdateDeviceDto } from './devices.dto';
import { DevicesService } from './devices.service';

@ApiTags('Devices')
@ApiBearerAuth()
@Controller({ path: 'devices', version: '1' })
export class DevicesController {
  constructor(private readonly devices: DevicesService) {}

  /** Register a device (status PENDING). The response contains the device secret — shown only once. */
  @Post()
  @RequirePermissions(Permission.DEVICES_MANAGE)
  register(@Body() dto: RegisterDeviceDto, @CurrentUser() user: UserActor) {
    return this.devices.register(dto, user);
  }

  @Get()
  @RequirePermissions(Permission.DEVICES_READ)
  list(@Query() q: DeviceQueryDto, @CurrentUser() user: UserActor) {
    return this.devices.list(q, user.scope);
  }

  /** Device status, last seen, last sync and the latest heartbeat report. */
  @Get(':id')
  @RequirePermissions(Permission.DEVICES_READ)
  get(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: UserActor) {
    return this.devices.get(id, user.scope);
  }

  @Patch(':id')
  @RequirePermissions(Permission.DEVICES_MANAGE)
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateDeviceDto, @CurrentUser() user: UserActor) {
    return this.devices.update(id, dto, user);
  }

  @Post(':id/activate')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(Permission.DEVICES_MANAGE)
  activate(@Param('id', ParseUUIDPipe) id: string, @Body() dto: DeviceStatusChangeDto, @CurrentUser() user: UserActor) {
    return this.devices.activate(id, dto.reason, user);
  }

  /** Temporarily block syncing (reversible with activate). */
  @Post(':id/suspend')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(Permission.DEVICES_MANAGE)
  suspend(@Param('id', ParseUUIDPipe) id: string, @Body() dto: DeviceStatusChangeDto, @CurrentUser() user: UserActor) {
    return this.devices.suspend(id, dto.reason, user);
  }

  /** Permanently block a lost/stolen device. Historical attendance from it is kept. */
  @Post(':id/revoke')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(Permission.DEVICES_MANAGE)
  revoke(@Param('id', ParseUUIDPipe) id: string, @Body() dto: DeviceStatusChangeDto, @CurrentUser() user: UserActor) {
    return this.devices.revoke(id, dto.reason, user);
  }

  /** Retire a device from service. */
  @Post(':id/decommission')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(Permission.DEVICES_MANAGE)
  decommission(@Param('id', ParseUUIDPipe) id: string, @Body() dto: DeviceStatusChangeDto, @CurrentUser() user: UserActor) {
    return this.devices.decommission(id, dto.reason, user);
  }

  /** New secret (shown once). The old secret and its tokens are invalid immediately. */
  @Post(':id/credentials/rotate')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(Permission.DEVICES_MANAGE)
  rotate(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: UserActor) {
    return this.devices.rotateCredentials(id, user);
  }

  /** Synchronization history (token, snapshot, upload, heartbeat) with counts, timing and errors. */
  @Get(':id/sync-events')
  @RequirePermissions(Permission.DEVICES_READ)
  syncEvents(@Param('id', ParseUUIDPipe) id: string, @Query() q: SyncEventQueryDto, @CurrentUser() user: UserActor) {
    return this.devices.syncEvents(id, q, user.scope);
  }
}
