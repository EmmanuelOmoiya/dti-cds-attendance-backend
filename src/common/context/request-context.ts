import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

export interface RequestContextData {
  requestId: string;
  ip?: string;
  userId?: string;
  deviceId?: string;
}

const storage = new AsyncLocalStorage<RequestContextData>();

/** Per-request context (request id, client ip, actor) available without parameter threading. */
export const RequestContext = {
  run<T>(data: RequestContextData, fn: () => T): T {
    return storage.run(data, fn);
  },
  get(): RequestContextData | undefined {
    return storage.getStore();
  },
  set(patch: Partial<RequestContextData>): void {
    const store = storage.getStore();
    if (store) Object.assign(store, patch);
  },
};

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * Express middleware: accepts a well-formed incoming X-Request-Id (or generates one), echoes it
 * in the response, and opens the async context for the rest of the request.
 */
export function requestContextMiddleware(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.header('x-request-id');
  const requestId = incoming && REQUEST_ID_PATTERN.test(incoming) ? incoming : randomUUID();
  (req as Request & { id: string }).id = requestId;
  res.setHeader('X-Request-Id', requestId);
  RequestContext.run({ requestId, ip: req.ip }, () => next());
}
