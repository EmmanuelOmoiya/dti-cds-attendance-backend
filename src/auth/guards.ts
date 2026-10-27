import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AppError } from '../common/errors/app-error';
import { RequestContext } from '../common/context/request-context';
import { PrismaService } from '../common/prisma/prisma.service';
import { UserStatus } from '../generated/prisma/client';
import { AccessScope } from './access-scope';
import { AuthService } from './auth.service';
import { AuthedRequest, IS_DEVICE_ROUTE, IS_PUBLIC, REQUIRED_PERMISSIONS } from './decorators';
import { Permission, roleHasPermission } from './permissions';

function bearer(req: AuthedRequest): string | undefined {
  const header = req.header('authorization');
  if (!header) return undefined;
  const [scheme, token] = header.split(' ');
  return scheme?.toLowerCase() === 'bearer' && token ? token : undefined;
}

/**
 * Global guard: every route requires a valid user access token unless marked @Public() or
 * @DeviceRoute(). The user (status, role, group scopes) is re-read from the database on each
 * request, so disabling a user or removing a group scope takes effect immediately.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly auth: AuthService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;
    if (this.reflector.getAllAndOverride<boolean>(IS_DEVICE_ROUTE, targets)) return true;

    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const token = bearer(req);
    if (!token) throw AppError.unauthenticated();

    let userId: string;
    try {
      userId = this.auth.verifyAccessToken(token).sub;
    } catch {
      throw AppError.unauthenticated('Invalid or expired access token');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { groupScopes: { select: { groupId: true } } },
    });
    if (!user || user.status !== UserStatus.ACTIVE) throw AppError.unauthenticated('Account is not active');

    req.actor = {
      type: 'USER',
      id: user.id,
      email: user.email,
      role: user.role,
      scope: AccessScope.forRole(
        user.role,
        user.groupScopes.map((s) => s.groupId),
      ),
    };
    RequestContext.set({ userId: user.id });
    return true;
  }
}

/** Global guard: enforces @RequirePermissions against the role → permission matrix. */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Permission[]>(REQUIRED_PERMISSIONS, [ctx.getHandler(), ctx.getClass()]);
    if (!required?.length) return true;
    const actor = ctx.switchToHttp().getRequest<AuthedRequest>().actor;
    if (!actor || actor.type !== 'USER') throw AppError.forbidden();
    const missing = required.filter((p) => !roleHasPermission(actor.role, p));
    if (missing.length) throw AppError.forbidden();
    return true;
  }
}
