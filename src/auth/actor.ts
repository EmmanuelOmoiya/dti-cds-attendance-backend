import { Role } from '../generated/prisma/client';
import { AccessScope } from './access-scope';

/** An authenticated dashboard user, resolved fresh from the database on every request. */
export interface UserActor {
  type: 'USER';
  id: string;
  email: string;
  role: Role;
  scope: AccessScope;
}

/** An authenticated attendance device (only on /sync routes). */
export interface DeviceActor {
  type: 'DEVICE';
  id: string;
  deviceIdentifier: string;
  groupId: string;
}

/** Who performed an action, as recorded in the audit log. */
export type AuditActor =
  | { type: 'USER'; id: string }
  | { type: 'DEVICE'; id: string }
  | { type: 'SYSTEM'; id?: null }
  | { type: 'ANONYMOUS'; id?: null };

export const SYSTEM_ACTOR: AuditActor = { type: 'SYSTEM', id: null };

export function auditActor(actor: UserActor | DeviceActor): AuditActor {
  return { type: actor.type, id: actor.id };
}
