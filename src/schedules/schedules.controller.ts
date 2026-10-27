import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { UserActor } from '../auth/actor';
import { CurrentUser, RequirePermissions } from '../auth/decorators';
import { Permission } from '../auth/permissions';
import { CreateScheduleDto, EndScheduleDto, GenerateQueryDto, PreviewQueryDto, ScheduleQueryDto, UpdateScheduleDto } from './schedules.dto';
import { SchedulesService } from './schedules.service';

@ApiTags('Schedules')
@ApiBearerAuth()
@Controller({ path: 'schedules', version: '1' })
export class SchedulesController {
  constructor(private readonly schedules: SchedulesService) {}

  /** Create a recurring weekly CDS schedule; expected sessions are generated immediately. */
  @Post()
  @RequirePermissions(Permission.SCHEDULES_WRITE)
  create(@Body() dto: CreateScheduleDto, @CurrentUser() user: UserActor) {
    return this.schedules.create(dto, user);
  }

  @Get()
  @RequirePermissions(Permission.SCHEDULES_READ)
  list(@Query() q: ScheduleQueryDto, @CurrentUser() user: UserActor) {
    return this.schedules.list(q, user.scope);
  }

  @Get(':id')
  @RequirePermissions(Permission.SCHEDULES_READ)
  get(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: UserActor) {
    return this.schedules.get(id, user.scope);
  }

  /** Dry-run: the occurrences this schedule would produce in a date range. Nothing is persisted. */
  @Get(':id/occurrences/preview')
  @RequirePermissions(Permission.SCHEDULES_READ)
  preview(@Param('id', ParseUUIDPipe) id: string, @Query() q: PreviewQueryDto, @CurrentUser() user: UserActor) {
    return this.schedules.preview(id, q.from, q.to, user.scope);
  }

  @Patch(':id')
  @RequirePermissions(Permission.SCHEDULES_WRITE)
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateScheduleDto, @CurrentUser() user: UserActor) {
    return this.schedules.update(id, dto.title, user);
  }

  /** Set the last date of the schedule. To change day/time: end this one, then create a new schedule. */
  @Post(':id/end')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(Permission.SCHEDULES_WRITE)
  end(@Param('id', ParseUUIDPipe) id: string, @Body() dto: EndScheduleDto, @CurrentUser() user: UserActor) {
    return this.schedules.end(id, dto.effectiveUntil, user);
  }

  @Post(':id/deactivate')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(Permission.SCHEDULES_WRITE)
  deactivate(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: UserActor) {
    return this.schedules.deactivate(id, user);
  }

  /** Generate missing expected sessions now (the periodic job does this automatically). */
  @Post(':id/generate')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(Permission.SCHEDULES_WRITE)
  generate(@Param('id', ParseUUIDPipe) id: string, @Query() q: GenerateQueryDto, @CurrentUser() user: UserActor) {
    return this.schedules.generateNow(id, q.backfillPast ?? false, user);
  }
}
