import { Module } from '@nestjs/common';
import { MembersModule } from '../members/members.module';
import { CardAssignmentsController, CardsController, MemberCardsController } from './cards.controller';
import { CardsService } from './cards.service';

@Module({
  imports: [MembersModule],
  controllers: [CardsController, CardAssignmentsController, MemberCardsController],
  providers: [CardsService],
})
export class CardsModule {}
