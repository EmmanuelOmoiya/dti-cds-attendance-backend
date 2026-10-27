import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { RequestContext } from '../common/context/request-context';
import { AuthedRequest } from '../auth/decorators';
import { DeviceAuthService } from './device-auth.service';

/** Authenticates and authorizes a device on every protected /sync request. User tokens are refused. */
@Injectable()
export class DeviceAuthGuard implements CanActivate {
  constructor(private readonly deviceAuth: DeviceAuthService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const header = req.header('authorization') ?? '';
    const [scheme, token] = header.split(' ');
    const actor = await this.deviceAuth.authenticate(scheme?.toLowerCase() === 'bearer' ? token : undefined);
    req.actor = actor;
    RequestContext.set({ deviceId: actor.id });
    return true;
  }
}
