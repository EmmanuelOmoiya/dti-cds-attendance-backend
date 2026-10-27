import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { Request } from 'express';
import type { DeviceActor, UserActor } from './actor';
import type { Permission } from './permissions';

export const IS_PUBLIC = 'isPublic';
export const IS_DEVICE_ROUTE = 'isDeviceRoute';
export const REQUIRED_PERMISSIONS = 'requiredPermissions';

/** No authentication required (health, login, device token exchange). */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** Authenticated by DeviceAuthGuard instead of the user JWT guard. User tokens are refused. */
export const DeviceRoute = () => SetMetadata(IS_DEVICE_ROUTE, true);

/** The user must hold every listed permission (group scope is checked in services). */
export const RequirePermissions = (...permissions: Permission[]) => SetMetadata(REQUIRED_PERMISSIONS, permissions);

export type AuthedRequest = Request & { actor?: UserActor | DeviceActor };

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): UserActor => {
  const actor = ctx.switchToHttp().getRequest<AuthedRequest>().actor;
  if (!actor || actor.type !== 'USER') throw new Error('CurrentUser used on a route without user authentication');
  return actor;
});

export const CurrentDevice = createParamDecorator((_: unknown, ctx: ExecutionContext): DeviceActor => {
  const actor = ctx.switchToHttp().getRequest<AuthedRequest>().actor;
  if (!actor || actor.type !== 'DEVICE') throw new Error('CurrentDevice used on a route without device authentication');
  return actor;
});
