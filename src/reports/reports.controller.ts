import { Controller, Get, Param, ParseUUIDPipe, Query, Res, StreamableFile } from '@nestjs/common';
import { ApiBearerAuth, ApiProduces, ApiTags } from '@nestjs/swagger';
import { IsIn, IsOptional, Matches } from 'class-validator';
import type { Response } from 'express';
import type { UserActor } from '../auth/actor';
import { CurrentUser, RequirePermissions } from '../auth/decorators';
import { Permission, roleHasPermission } from '../auth/permissions';
import { AppError } from '../common/errors/app-error';
import { CsvFormatter, ReportFormatter, ReportTable } from './formatters';
import { ReportsService } from './reports.service';

class ReportQueryDto {
  /** Inclusive local date range on the session date (YYYY-MM-DD). Omit for all time. */
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/)
  from?: string;

  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/)
  to?: string;

  /** `csv` downloads the tabular part of the report. */
  @IsOptional() @IsIn(['json', 'csv'])
  format?: 'json' | 'csv';
}

const FORMATTERS: Record<string, ReportFormatter> = { csv: new CsvFormatter() };

@ApiTags('Reports')
@ApiBearerAuth()
@Controller({ path: 'reports', version: '1' })
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  /** Eligible members of one session with PRESENT / ABSENT, plus summary statistics. */
  @Get('sessions/:id')
  @ApiProduces('application/json', 'text/csv')
  @RequirePermissions(Permission.REPORTS_READ)
  async session(@Param('id', ParseUUIDPipe) id: string, @Query() q: ReportQueryDto, @CurrentUser() user: UserActor, @Res({ passthrough: true }) res: Response) {
    const r = await this.reports.sessionReport(id, user.scope);
    return this.respond(r, () => this.reports.sessionTable(r), q, user, res);
  }

  /** Per-session statistics for a group over a date range, with exclusions and data-quality warnings. */
  @Get('groups/:id')
  @ApiProduces('application/json', 'text/csv')
  @RequirePermissions(Permission.REPORTS_READ)
  async group(@Param('id', ParseUUIDPipe) id: string, @Query() q: ReportQueryDto, @CurrentUser() user: UserActor, @Res({ passthrough: true }) res: Response) {
    const r = await this.reports.groupReport(id, user.scope, q.from, q.to);
    return this.respond(r, () => this.reports.groupTable(r), q, user, res);
  }

  /** Per-member statistics for a group: eligible held sessions, present, absent, attendance %. */
  @Get('groups/:id/members')
  @ApiProduces('application/json', 'text/csv')
  @RequirePermissions(Permission.REPORTS_READ)
  async groupMembers(@Param('id', ParseUUIDPipe) id: string, @Query() q: ReportQueryDto, @CurrentUser() user: UserActor, @Res({ passthrough: true }) res: Response) {
    const r = await this.reports.groupMembersReport(id, user.scope, q.from, q.to);
    return this.respond(r, () => this.reports.groupMembersTable(r), q, user, res);
  }

  /** A member's attendance history over every session they were eligible for. */
  @Get('members/:id')
  @ApiProduces('application/json', 'text/csv')
  @RequirePermissions(Permission.REPORTS_READ)
  async member(@Param('id', ParseUUIDPipe) id: string, @Query() q: ReportQueryDto, @CurrentUser() user: UserActor, @Res({ passthrough: true }) res: Response) {
    const r = await this.reports.memberReport(id, user.scope, q.from, q.to);
    return this.respond(r, () => this.reports.memberTable(r), q, user, res);
  }

  private respond<T>(report: T, table: () => ReportTable, q: ReportQueryDto, user: UserActor, res: Response): T | StreamableFile {
    if (!q.format || q.format === 'json') return report;
    if (!roleHasPermission(user.role, Permission.REPORTS_EXPORT)) throw AppError.forbidden();
    const formatter = FORMATTERS[q.format];
    const t = table();
    const filename = `${t.title.replace(/[^A-Za-z0-9._-]+/g, '_')}.${formatter.extension}`;
    res.setHeader('Content-Type', formatter.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return new StreamableFile(formatter.render(t));
  }
}
