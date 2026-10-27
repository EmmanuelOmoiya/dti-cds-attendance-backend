import { HttpStatus } from '@nestjs/common';
import { ErrorCode } from './error-codes';

/**
 * Application error with a stable code. Thrown by services; rendered by AllExceptionsFilter as
 * `{ error: { code, message, details, requestId } }`.
 */
export class AppError extends Error {
  constructor(
    readonly status: HttpStatus,
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }

  static notFound(entity: string): AppError {
    return new AppError(HttpStatus.NOT_FOUND, ErrorCode.NOT_FOUND, `${entity} not found`);
  }

  static conflict(code: ErrorCode, message: string, details?: unknown): AppError {
    return new AppError(HttpStatus.CONFLICT, code, message, details);
  }

  /** A well-formed request that violates a business rule. */
  static rule(code: ErrorCode, message: string, details?: unknown): AppError {
    return new AppError(HttpStatus.UNPROCESSABLE_ENTITY, code, message, details);
  }

  static transition(entity: string, from: string, action: string): AppError {
    return new AppError(
      HttpStatus.CONFLICT,
      ErrorCode.INVALID_STATE_TRANSITION,
      `Cannot ${action} a ${entity} whose status is ${from}`,
      { from, action },
    );
  }

  static forbidden(message = 'You do not have permission to perform this action'): AppError {
    return new AppError(HttpStatus.FORBIDDEN, ErrorCode.FORBIDDEN, message);
  }

  static unauthenticated(
    message = 'Authentication required',
    code: ErrorCode = ErrorCode.UNAUTHENTICATED,
  ): AppError {
    return new AppError(HttpStatus.UNAUTHORIZED, code, message);
  }

  static validation(message: string, details?: unknown): AppError {
    return new AppError(HttpStatus.BAD_REQUEST, ErrorCode.VALIDATION_FAILED, message, details);
  }
}
