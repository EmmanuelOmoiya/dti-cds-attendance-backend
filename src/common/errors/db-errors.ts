/**
 * Recognise PostgreSQL constraint violations surfaced through Prisma. With the pg driver
 * adapter the SQLSTATE and constraint name can sit at different depths of the error object,
 * so we flatten the interesting string fields and match on them.
 */

const FIELDS = ['code', 'message', 'constraint', 'originalCode', 'originalMessage', 'kind', 'name'];

function collect(err: unknown, depth: number, acc: string[]): void {
  if (err == null || depth > 6) return;
  if (typeof err === 'string') {
    acc.push(err);
    return;
  }
  if (typeof err !== 'object') return;
  const o = err as Record<string, unknown>;
  for (const key of FIELDS) {
    const v = o[key];
    if (typeof v === 'string') acc.push(v);
    else if (v && typeof v === 'object' && key === 'constraint') acc.push(JSON.stringify(v));
  }
  if (o.target) acc.push(JSON.stringify(o.target));
  for (const key of ['meta', 'cause', 'driverAdapterError']) {
    if (o[key] && typeof o[key] === 'object') collect(o[key], depth + 1, acc);
  }
}

export function dbErrorText(err: unknown): string {
  const acc: string[] = [];
  collect(err, 0, acc);
  return acc.join(' | ');
}

/** Unique-constraint violation (SQLSTATE 23505 / Prisma P2002), optionally naming a field/constraint. */
export function isUniqueViolation(err: unknown, hint?: string): boolean {
  const t = dbErrorText(err);
  const match = t.includes('P2002') || t.includes('23505') || t.includes('UniqueConstraintViolation');
  return match && (!hint || t.includes(hint));
}

/** Exclusion-constraint violation (SQLSTATE 23P01), optionally for a named constraint. */
export function isExclusionViolation(err: unknown, constraint?: string): boolean {
  const t = dbErrorText(err);
  const match = t.includes('23P01') || t.includes('exclusion constraint');
  return match && (!constraint || t.includes(constraint));
}

/** CHECK-constraint violation (SQLSTATE 23514). */
export function isCheckViolation(err: unknown): boolean {
  const t = dbErrorText(err);
  return t.includes('23514') || t.includes('check constraint');
}

/** Serialization failure / deadlock / write conflict — safe to retry the transaction. */
export function isTransientTxError(err: unknown): boolean {
  const t = dbErrorText(err);
  return t.includes('40001') || t.includes('40P01') || t.includes('P2034');
}
