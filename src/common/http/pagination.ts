import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Matches, Max, Min } from 'class-validator';
import { AppError } from '../errors/app-error';

/** Common list query parameters: `?page=1&pageSize=20&sort=createdAt:desc,name:asc`. */
export class PageQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  page?: number = 1;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100)
  pageSize?: number = 20;

  /** Comma-separated `field:asc|desc`; allowed fields depend on the resource. */
  @IsOptional() @IsString() @Matches(/^[A-Za-z]+(:(asc|desc))?(,[A-Za-z]+(:(asc|desc))?)*$/)
  sort?: string;
}

export interface PageMeta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

/** A page of results. The response interceptor renders it as `{ data, meta }`. */
export class Page<T> {
  constructor(
    readonly items: T[],
    readonly meta: PageMeta,
  ) {}

  static of<T>(items: T[], total: number, q: PageQueryDto): Page<T> {
    const page = q.page ?? 1;
    const pageSize = q.pageSize ?? 20;
    return new Page(items, { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) });
  }
}

export function paging(q: PageQueryDto): { skip: number; take: number } {
  const page = q.page ?? 1;
  const pageSize = q.pageSize ?? 20;
  return { skip: (page - 1) * pageSize, take: pageSize };
}

/**
 * Turns `sort=a:desc,b` into a Prisma orderBy array, accepting only whitelisted fields.
 * Unknown fields are a 400, not silently ignored.
 */
export function orderBy(
  sort: string | undefined,
  allowed: readonly string[],
  fallback: Record<string, 'asc' | 'desc'>[],
): Record<string, 'asc' | 'desc'>[] {
  if (!sort) return fallback;
  return sort.split(',').map((part) => {
    const [field, dir = 'asc'] = part.split(':');
    if (!allowed.includes(field)) {
      throw AppError.validation(`Cannot sort by '${field}'`, { allowed });
    }
    return { [field]: dir as 'asc' | 'desc' };
  });
}
