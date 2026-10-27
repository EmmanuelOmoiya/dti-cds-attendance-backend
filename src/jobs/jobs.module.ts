import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { SchedulesModule } from '../schedules/schedules.module';
import { SessionsModule } from '../sessions/sessions.module';
import { JobsService } from './jobs.service';

@Module({
  imports: [ScheduleModule.forRoot(), SchedulesModule, SessionsModule],
  providers: [JobsService],
  exports: [JobsService],
})
export class JobsModule {}
