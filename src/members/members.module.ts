import { Module } from '@nestjs/common';
import { MembersController, MembershipsController } from './members.controller';
import { MembersService } from './members.service';
import { MembershipsService } from './memberships.service';

@Module({
  controllers: [MembersController, MembershipsController],
  providers: [MembersService, MembershipsService],
  exports: [MembersService, MembershipsService],
})
export class MembersModule {}
