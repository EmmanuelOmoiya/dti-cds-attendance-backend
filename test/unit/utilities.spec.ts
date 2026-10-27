import { diff, redact } from '../../src/audit/audit.service';
import { normalizeCardUid } from '../../src/cards/card-uid';
import { AppError } from '../../src/common/errors/app-error';
import { isExclusionViolation, isUniqueViolation } from '../../src/common/errors/db-errors';
import { safeEqualHex, sha256 } from '../../src/common/security/crypto';
import { CsvFormatter, csvCell } from '../../src/reports/formatters';

describe('card UID normalization', () => {
  it('accepts common reader formats and canonicalises them', () => {
    expect(normalizeCardUid('04:a2:3b:1c')).toBe('04A23B1C');
    expect(normalizeCardUid('04-A2-3B-1C-5D-2E-80')).toBe('04A23B1C5D2E80');
    expect(normalizeCardUid(' 04a23b1c5d2e80 ')).toBe('04A23B1C5D2E80');
  });

  it.each(['04A23B', 'XYZXYZXYZ', '04A23B1C5', ''])('rejects %p', (uid) => {
    expect(() => normalizeCardUid(uid)).toThrow(AppError);
  });
});

describe('CSV formatter', () => {
  it('quotes separators, quotes and newlines', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('line\nbreak')).toBe('"line\nbreak"');
    expect(csvCell(null)).toBe('');
    expect(csvCell(83.33)).toBe('83.33');
  });

  it('neutralises spreadsheet formula injection', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
  });

  it('renders a BOM, header and rows with CRLF', () => {
    const out = new CsvFormatter()
      .render({ title: 't', columns: [{ key: 'a', header: 'A' }, { key: 'b', header: 'B' }], rows: [{ a: 1, b: 'x' }] })
      .toString('utf8');
    expect(out).toBe('﻿A,B\r\n1,x\r\n');
  });
});

describe('audit redaction', () => {
  it('removes credential-like fields at any depth', () => {
    expect(redact({ email: 'a@b.c', password: 'p', nested: { secretHash: 'h', ok: 1 }, list: [{ refreshToken: 't' }] })).toEqual({
      email: 'a@b.c',
      password: '[REDACTED]',
      nested: { secretHash: '[REDACTED]', ok: 1 },
      list: [{ refreshToken: '[REDACTED]' }],
    });
  });

  it('diff reports only changed fields', () => {
    expect(diff<Record<string, unknown>>({ a: 1, b: 'x' }, { a: 1, b: 'y', c: undefined })).toEqual({ b: { from: 'x', to: 'y' } });
  });
});

describe('crypto helpers', () => {
  it('compares digests in constant time and rejects mismatches', () => {
    expect(safeEqualHex(sha256('x'), sha256('x'))).toBe(true);
    expect(safeEqualHex(sha256('x'), sha256('y'))).toBe(false);
    expect(safeEqualHex(sha256('x'), 'abcd')).toBe(false);
  });
});

describe('database error classification', () => {
  it('recognises unique and exclusion violations, including nested driver-adapter errors', () => {
    expect(isUniqueViolation({ code: 'P2002', meta: { target: ['cardUid'] } }, 'cardUid')).toBe(true);
    expect(isExclusionViolation({ meta: { driverAdapterError: { cause: { originalCode: '23P01', constraint: 'GroupMembership_no_overlap' } } } }, 'GroupMembership_no_overlap')).toBe(true);
    expect(isExclusionViolation({ code: 'P2002' })).toBe(false);
  });
});
