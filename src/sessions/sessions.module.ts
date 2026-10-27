import { Module } from '@nestjs/common';
import { AttendanceModule } from '../attendance/attendance.module';
import { ReportsModule } from '../reports/reports.module';
import { SessionsController } from './sessions.controller';
import { SessionsService } from './sessions.service';

@Module({
  imports: [AttendanceModule, ReportsModule],
  controllers: [SessionsController],
  providers: [SessionsService],
  exports: [SessionsService],
})
export class SessionsModule {}
