import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { UserActor } from '../auth/actor';
import { CurrentUser, RequirePermissions } from '../auth/decorators';
import { Permission } from '../auth/permissions';
import {
  AssignCardDto,
  AssignmentQueryDto,
  CardHistoryQueryDto,
  CardQueryDto,
  EndAssignmentDto,
  RegisterCardDto,
  ReplaceCardDto,
  RevokeCardDto,
} from './cards.dto';
import { CardsService } from './cards.service';

@ApiTags('Cards')
@ApiBearerAuth()
@Controller({ path: 'cards', version: '1' })
export class CardsController {
  constructor(private readonly cards: CardsService) {}

  /** Register a blank card into the shared inventory (status UNASSIGNED). */
  @Post()
  @RequirePermissions(Permission.CARDS_WRITE)
  register(@Body() dto: RegisterCardDto, @CurrentUser() user: UserActor) {
    return this.cards.register(dto.cardUid, dto.label, user);
  }

  @Get()
  @RequirePermissions(Permission.CARDS_READ)
  list(@Query() q: CardQueryDto, @CurrentUser() user: UserActor) {
    return this.cards.list(q, user.scope);
  }

  /** Full assignment history of one physical card, looked up by UID. */
  @Get('history')
  @RequirePermissions(Permission.CARDS_READ)
  history(@Query() q: CardHistoryQueryDto, @CurrentUser() user: UserActor) {
    return this.cards.historyByUid(q.cardUid, user.scope);
  }

  @Get(':id')
  @RequirePermissions(Permission.CARDS_READ)
  get(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: UserActor) {
    return this.cards.get(id, user.scope);
  }

  /** Revoke a card (lost/damaged/stolen/retired). Ends its active assignment; taps after this are rejected. */
  @Post(':id/revoke')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(Permission.CARDS_WRITE)
  revoke(@Param('id', ParseUUIDPipe) id: string, @Body() dto: RevokeCardDto, @CurrentUser() user: UserActor) {
    return this.cards.revoke(id, dto, user);
  }

  /** Return a revoked card to stock (found / repaired). */
  @Post(':id/reinstate')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(Permission.CARDS_WRITE)
  reinstate(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: UserActor) {
    return this.cards.reinstate(id, user);
  }
}

@ApiTags('Card assignments')
@ApiBearerAuth()
@Controller({ path: 'card-assignments', version: '1' })
export class CardAssignmentsController {
  constructor(private readonly cards: CardsService) {}

  @Get()
  @RequirePermissions(Permission.CARDS_READ)
  list(@Query() q: AssignmentQueryDto, @CurrentUser() user: UserActor) {
    return this.cards.listAssignments(q, user.scope);
  }

  /** Assign a card to a member (cardId or cardUid; unknown UIDs are registered). */
  @Post()
  @RequirePermissions(Permission.CARDS_WRITE)
  assign(@Body() dto: AssignCardDto, @CurrentUser() user: UserActor) {
    return this.cards.assign(dto, user);
  }

  @Post(':id/end')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(Permission.CARDS_WRITE)
  end(@Param('id', ParseUUIDPipe) id: string, @Body() dto: EndAssignmentDto, @CurrentUser() user: UserActor) {
    return this.cards.endAssignment(id, dto, user);
  }
}

@ApiTags('Card assignments')
@ApiBearerAuth()
@Controller({ path: 'members', version: '1' })
export class MemberCardsController {
  constructor(private readonly cards: CardsService) {}

  /** Replace the member's current card: old assignment ends (history kept), new one starts at the same instant. */
  @Post(':id/card-replacement')
  @RequirePermissions(Permission.CARDS_WRITE)
  replace(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ReplaceCardDto, @CurrentUser() user: UserActor) {
    return this.cards.replace(id, dto, user);
  }

  @Get(':id/card-assignments')
  @RequirePermissions(Permission.CARDS_READ)
  history(@Param('id', ParseUUIDPipe) id: string, @Query() q: AssignmentQueryDto, @CurrentUser() user: UserActor) {
    return this.cards.listAssignments({ ...q, memberId: id }, user.scope);
  }
}
