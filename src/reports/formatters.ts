/**
 * Report rendering is separated from report computation: services produce a ReportTable, and a
 * ReportFormatter turns it into bytes. CSV ships now; a PDF formatter can implement the same
 * interface later without touching any query.
 */
export interface ReportColumn {
  key: string;
  header: string;
}

export interface ReportTable {
  title: string;
  columns: ReportColumn[];
  rows: Record<string, unknown>[];
}

export interface ReportFormatter {
  readonly contentType: string;
  readonly extension: string;
  render(table: ReportTable): Buffer;
}

/** Cells starting with these characters are interpreted as formulas by spreadsheet apps. */
const FORMULA_PREFIX = /^[=+\-@\t\r]/;

export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let s = value instanceof Date ? value.toISOString() : typeof value === 'number' ? String(value) : String(value);
  if (typeof value === 'string' && FORMULA_PREFIX.test(s)) s = `'${s}`; // CSV/formula-injection guard
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** RFC 4180 CSV with a UTF-8 BOM so Excel opens names with accents correctly. */
export class CsvFormatter implements ReportFormatter {
  readonly contentType = 'text/csv; charset=utf-8';
  readonly extension = 'csv';

  render(table: ReportTable): Buffer {
    const lines = [table.columns.map((c) => csvCell(c.header)).join(',')];
    for (const row of table.rows) lines.push(table.columns.map((c) => csvCell(row[c.key])).join(','));
    return Buffer.from(`﻿${lines.join('\r\n')}\r\n`, 'utf8');
  }
}
