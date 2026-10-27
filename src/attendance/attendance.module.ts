import { Module } from '@nestjs/common';
import { AttendanceIngestionService } from './attendance-ingestion.service';
import { AttendanceController } from './attendance.controller';
import { AttendanceService } from './attendance.service';

@Module({
  controllers: [AttendanceController],
  providers: [AttendanceService, AttendanceIngestionService],
  exports: [AttendanceService, AttendanceIngestionService],
})
export class AttendanceModule {}
