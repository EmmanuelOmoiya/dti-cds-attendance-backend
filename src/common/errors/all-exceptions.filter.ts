import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import type { Response } from 'express';
import { RequestContext } from '../context/request-context';
import { AppError } from './app-error';
import { dbErrorText, isCheckViolation, isExclusionViolation, isUniqueViolation } from './db-errors';
import { ErrorCode } from './error-codes';

interface ErrorBody {
  error: { code: string; message: string; details?: unknown; requestId?: string };
}

const STATUS_CODES: Record<number, ErrorCode> = {
  400: ErrorCode.VALIDATION_FAILED,
  401: ErrorCode.UNAUTHENTICATED,
  403: ErrorCode.FORBIDDEN,
  404: ErrorCode.NOT_FOUND,
  409: ErrorCode.CONFLICT,
  413: ErrorCode.PAYLOAD_TOO_LARGE,
  429: ErrorCode.RATE_LIMITED,
};

/**
 * Single place that turns any thrown value into the public error shape. Internal details
 * (stack traces, SQL, constraint internals) are logged, never returned.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const { status, body } = this.toResponse(exception);
    body.error.requestId = RequestContext.get()?.requestId;
    if (status >= 500) {
      this.logger.error(
        { err: exception instanceof Error ? { name: exception.name, message: exception.message, stack: exception.stack } : exception },
        'Unhandled error',
      );
    }
    if (!res.headersSent) res.status(status).json(body);
  }

  private toResponse(exception: unknown): { status: number; body: ErrorBody } {
    if (exception instanceof AppError) {
      return this.body(exception.status, exception.code, exception.message, exception.details);
    }
    if (exception instanceof ThrottlerException) {
      return this.body(429, ErrorCode.RATE_LIMITED, 'Too many requests, slow down');
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const response = exception.getResponse();
      const message =
        typeof response === 'object' && response && 'message' in response
          ? String((response as { message: unknown }).message)
          : exception.message;
      return this.body(status, STATUS_CODES[status] ?? ErrorCode.INTERNAL_ERROR, message);
    }
    // Errors raised by Express body parsing (malformed JSON, oversized payload).
    if (exception && typeof exception === 'object' && 'type' in exception && 'status' in exception) {
      const e = exception as { type: string; status: number };
      if (e.type === 'entity.too.large') return this.body(413, ErrorCode.PAYLOAD_TOO_LARGE, 'Request body too large');
      if (e.type === 'entity.parse.failed') return this.body(400, ErrorCode.VALIDATION_FAILED, 'Malformed JSON body');
    }
    // Database constraint violations that escaped service-level handling: still a client conflict.
    if (isUniqueViolation(exception) || isExclusionViolation(exception)) {
      return this.body(HttpStatus.CONFLICT, ErrorCode.CONFLICT, 'The request conflicts with existing data');
    }
    if (isCheckViolation(exception)) {
      return this.body(HttpStatus.UNPROCESSABLE_ENTITY, ErrorCode.VALIDATION_FAILED, 'The request violates a data integrity rule');
    }
    if (dbErrorText(exception).includes('P2025')) {
      return this.body(HttpStatus.NOT_FOUND, ErrorCode.NOT_FOUND, 'Resource not found');
    }
    return this.body(HttpStatus.INTERNAL_SERVER_ERROR, ErrorCode.INTERNAL_ERROR, 'An unexpected error occurred');
  }

  private body(status: number, code: string, message: string, details?: unknown) {
    return { status, body: { error: { code, message, ...(details !== undefined ? { details } : {}) } } };
  }
}
