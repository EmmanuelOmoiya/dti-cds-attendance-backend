import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { UserActor } from '../auth/actor';
import { CurrentUser, RequirePermissions } from '../auth/decorators';
import { Permission } from '../auth/permissions';
import { AuditQueryDto } from './audit.dto';
import { AuditService } from './audit.service';

@ApiTags('Audit logs')
@ApiBearerAuth()
@Controller({ path: 'audit-logs', version: '1' })
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  /** Audit trail. CDS admins only see entries tied to their groups. */
  @Get()
  @RequirePermissions(Permission.AUDIT_READ)
  list(@Query() q: AuditQueryDto, @CurrentUser() user: UserActor) {
    return this.audit.list(q, user.scope);
  }
}
