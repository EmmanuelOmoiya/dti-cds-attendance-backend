import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** SHA-256 hex digest. Appropriate for high-entropy random secrets/tokens (not passwords). */
export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Cryptographically random URL-safe token with an optional readable prefix. */
export function randomToken(bytes = 32, prefix = ''): string {
  return `${prefix}${randomBytes(bytes).toString('base64url')}`;
}

/** Constant-time comparison of two hex digests. */
export function safeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ab.length === bb.length && ab.length > 0 && timingSafeEqual(ab, bb);
}

/** Shortened card UID for logs (UIDs are not secret, but logs need not carry them in full). */
export function maskUid(uid: string): string {
  return uid.length <= 6 ? uid : `${uid.slice(0, 4)}…${uid.slice(-2)}`;
}
