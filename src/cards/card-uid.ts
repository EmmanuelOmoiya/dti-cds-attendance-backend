import { AppError } from '../common/errors/app-error';
import { ErrorCode } from '../common/errors/error-codes';

/**
 * Canonical card UID: upper-case hex without separators. NFC UIDs are 4, 7 or 10 bytes; we
 * accept 4–16 bytes to stay reader-agnostic. "04:a2:3b:1c" and "04A23B1C" are the same card.
 */
export function normalizeCardUid(raw: string): string {
  const uid = raw.replace(/[\s:-]/g, '').toUpperCase();
  if (!/^[0-9A-F]{8,32}$/.test(uid) || uid.length % 2 !== 0) {
    throw AppError.validation('cardUid must be 4–16 bytes of hexadecimal', [{ field: 'cardUid', issues: [ErrorCode.INVALID_CARD_UID] }]);
  }
  return uid;
}

/** Same as normalizeCardUid but returns null instead of throwing (for device uploads). */
export function tryNormalizeCardUid(raw: string): string | null {
  try {
    return normalizeCardUid(raw);
  } catch {
    return null;
  }
}
