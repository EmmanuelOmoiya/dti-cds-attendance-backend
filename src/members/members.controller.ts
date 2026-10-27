import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Matches, IsOptional } from 'class-validator';
import type { UserActor } from '../auth/actor';
import { CurrentUser, RequirePermissions } from '../auth/decorators';
import { Permission } from '../auth/permissions';
import {
  CorrectMembershipDto,
  CreateMemberDto,
  CreateMembershipDto,
  DeactivateMemberDto,
  EndMembershipDto,
  MemberQueryDto,
  MembershipQueryDto,
  TransferMemberDto,
  UpdateMemberDto,
} from './members.dto';
import { MembersService } from './members.service';
import { MembershipsService } from './memberships.service';

class DateRangeQuery {
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/)
  from?: string;

  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/)
  to?: string;
}

@ApiTags('Members')
@ApiBearerAuth()
@Controller({ path: 'members', version: '1' })
export class MembersController {
  constructor(
    private readonly members: MembersService,
    private readonly memberships: MembershipsService,
  ) {}

  /** Register a corps member and their first CDS group membership (atomic). */
  @Post()
  @RequirePermissions(Permission.MEMBERS_WRITE)
  create(@Body() dto: CreateMemberDto, @CurrentUser() user: UserActor) {
    return this.members.create(dto, user);
  }

  @Get()
  @RequirePermissions(Permission.MEMBERS_READ)
  list(@Query() q: MemberQueryDto, @CurrentUser() user: UserActor) {
    return this.members.list(q, user.scope);
  }

  @Get(':id')
  @RequirePermissions(Permission.MEMBERS_READ)
  get(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: UserActor) {
    return this.members.get(id, user.scope);
  }

  @Patch(':id')
  @RequirePermissions(Permission.MEMBERS_WRITE)
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateMemberDto, @CurrentUser() user: UserActor) {
    return this.members.update(id, dto, user);
  }

  /** Ends the current membership and card assignment at effectiveAt; history is preserved. */
  @Post(':id/deactivate')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(Permission.MEMBERS_WRITE)
  deactivate(@Param('id', ParseUUIDPipe) id: string, @Body() dto: DeactivateMemberDto, @CurrentUser() user: UserActor) {
    return this.members.deactivate(id, dto, user);
  }

  @Post(':id/reactivate')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(Permission.MEMBERS_WRITE)
  reactivate(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: UserActor) {
    return this.members.reactivate(id, user);
  }

  /** Move to another CDS group: ends the current membership and starts a new one at the same instant. */
  @Post(':id/transfer')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(Permission.MEMBERS_WRITE)
  transfer(@Param('id', ParseUUIDPipe) id: string, @Body() dto: TransferMemberDto, @CurrentUser() user: UserActor) {
    return this.members.transfer(id, dto, user);
  }

  @Get(':id/memberships')
  @RequirePermissions(Permission.MEMBERS_READ)
  async membershipHistory(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: UserActor) {
    const m = await this.members.get(id, user.scope);
    return m.memberships;
  }

  /** Raw attendance records of the member. For eligibility-based statistics use /reports/members/:id. */
  @Get(':id/attendance')
  @RequirePermissions(Permission.ATTENDANCE_READ)
  attendance(@Param('id', ParseUUIDPipe) id: string, @Query() q: DateRangeQuery, @CurrentUser() user: UserActor) {
    return this.members.attendance(id, user.scope, q.from, q.to);
  }
}

@ApiTags('Memberships')
@ApiBearerAuth()
@Controller({ path: 'memberships', version: '1' })
export class MembershipsController {
  constructor(private readonly memberships: MembershipsService) {}

  @Get()
  @RequirePermissions(Permission.MEMBERS_READ)
  list(@Query() q: MembershipQueryDto, @CurrentUser() user: UserActor) {
    return this.memberships.list(q, user.scope);
  }

  @Get(':id')
  @RequirePermissions(Permission.MEMBERS_READ)
  get(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: UserActor) {
    return this.memberships.get(id, user.scope);
  }

  /** Add a membership (e.g. re-joining). Memberships of one member can never overlap. */
  @Post()
  @RequirePermissions(Permission.MEMBERS_WRITE)
  create(@Body() dto: CreateMembershipDto, @CurrentUser() user: UserActor) {
    return this.memberships.create(dto, user);
  }

  @Post(':id/end')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(Permission.MEMBERS_WRITE)
  end(@Param('id', ParseUUIDPipe) id: string, @Body() dto: EndMembershipDto, @CurrentUser() user: UserActor) {
    return this.memberships.end(id, dto, user);
  }

  /** Correct historical joinedAt/leftAt (audited with before/after; requires a note). */
  @Patch(':id')
  @RequirePermissions(Permission.MEMBERS_WRITE)
  correct(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CorrectMembershipDto, @CurrentUser() user: UserActor) {
    return this.memberships.correct(id, dto, user);
  }
}
