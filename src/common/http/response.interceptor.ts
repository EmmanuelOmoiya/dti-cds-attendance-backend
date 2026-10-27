import { CallHandler, ExecutionContext, Injectable, NestInterceptor, StreamableFile } from '@nestjs/common';
import { map, Observable } from 'rxjs';
import { Page } from './pagination';

/**
 * Consistent success envelope:
 *   single resource → { data: {...} }
 *   list            → { data: [...], meta: { page, pageSize, total, totalPages } }
 * Files/streams and empty (204/304) responses pass through untouched.
 */
@Injectable()
export class ResponseEnvelopeInterceptor implements NestInterceptor {
  intercept(_ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(
      map((result) => {
        if (result === undefined || result === null) return result;
        if (result instanceof StreamableFile || Buffer.isBuffer(result)) return result;
        if (result instanceof Page) return { data: result.items, meta: result.meta };
        return { data: result };
      }),
    );
  }
}
