import { Module } from '@nestjs/common';
import { AttendanceModule } from '../attendance/attendance.module';
import { AuthModule } from '../auth/auth.module';
import { DeviceAuthGuard } from './device-auth.guard';
import { DeviceAuthService } from './device-auth.service';
import { SyncController } from './sync.controller';
import { SyncService } from './sync.service';

@Module({
  imports: [AuthModule, AttendanceModule],
  controllers: [SyncController],
  providers: [DeviceAuthService, DeviceAuthGuard, SyncService],
  exports: [SyncService, DeviceAuthService],
})
export class SynchronizationModule {}
