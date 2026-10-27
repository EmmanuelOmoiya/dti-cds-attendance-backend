import { Body, Controller, Get, Headers, HttpCode, HttpStatus, Post, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import type { DeviceActor } from '../auth/actor';
import { CurrentDevice, DeviceRoute, Public } from '../auth/decorators';
import { perMinute } from '../common/http/throttle';
import { DeviceAuthGuard } from './device-auth.guard';
import { DeviceAuthService } from './device-auth.service';
import { DeviceTokenRequestDto, HeartbeatDto, UploadBatchDto } from './sync.dto';
import { SyncService } from './sync.service';

@ApiTags('Synchronization (device)')
@Controller({ path: 'sync', version: '1' })
export class SyncController {
  constructor(
    private readonly deviceAuth: DeviceAuthService,
    private readonly sync: SyncService,
  ) {}

  /** Exchange deviceIdentifier + secret for a short-lived device token. Only ACTIVE devices succeed. */
  @Public()
  @Throttle({ default: perMinute('THROTTLE_DEVICE_TOKEN_PER_MINUTE', 20) })
  @Post('token')
  @HttpCode(HttpStatus.OK)
  token(@Body() dto: DeviceTokenRequestDto) {
    return this.deviceAuth.issueToken(dto.deviceIdentifier, dto.secret);
  }

  /** Roster + sessions for offline operation. Send If-None-Match with the last ETag to get 304 when unchanged. */
  @DeviceRoute()
  @UseGuards(DeviceAuthGuard)
  @ApiBearerAuth()
  @ApiHeader({ name: 'If-None-Match', required: false })
  @Throttle({ default: perMinute('THROTTLE_SYNC_PER_MINUTE', 120) })
  @Get('snapshot')
  async snapshot(@CurrentDevice() device: DeviceActor, @Headers('if-none-match') ifNoneMatch: string | undefined, @Res({ passthrough: true }) res: Response) {
    const { notModified, snapshot } = await this.sync.snapshot(device, ifNoneMatch);
    res.setHeader('ETag', `"${snapshot.snapshotVersion}"`);
    res.setHeader('Cache-Control', 'no-cache');
    if (notModified) {
      res.status(HttpStatus.NOT_MODIFIED);
      return undefined;
    }
    return { snapshotVersion: snapshot.snapshotVersion, serverTime: snapshot.serverTime, ...snapshot.body };
  }

  /** Upload a batch of offline taps. Always answers per event; resending the same events is safe. */
  @DeviceRoute()
  @UseGuards(DeviceAuthGuard)
  @ApiBearerAuth()
  @Throttle({ default: perMinute('THROTTLE_SYNC_PER_MINUTE', 120) })
  @Post('attendance-batches')
  @HttpCode(HttpStatus.OK)
  upload(@CurrentDevice() device: DeviceActor, @Body() dto: UploadBatchDto) {
    return this.sync.uploadBatch(device, dto);
  }

  /** Device status report (firmware, battery, pending queue, clock). */
  @DeviceRoute()
  @UseGuards(DeviceAuthGuard)
  @ApiBearerAuth()
  @Throttle({ default: perMinute('THROTTLE_SYNC_PER_MINUTE', 120) })
  @Post('heartbeat')
  @HttpCode(HttpStatus.OK)
  heartbeat(@CurrentDevice() device: DeviceActor, @Body() dto: HeartbeatDto) {
    return this.sync.heartbeat(device, dto);
  }
}
