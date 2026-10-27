import { ValidationError, ValidationPipe } from '@nestjs/common';
import { AppError } from '../errors/app-error';

function flatten(errors: ValidationError[], parent = ''): { field: string; issues: string[] }[] {
  return errors.flatMap((e) => {
    const field = parent ? `${parent}.${e.property}` : e.property;
    const own = e.constraints ? [{ field, issues: Object.values(e.constraints) }] : [];
    return [...own, ...flatten(e.children ?? [], field)];
  });
}

/**
 * Strict request validation: unknown properties are rejected (not silently dropped), payloads
 * are transformed into DTO instances, and errors use the standard error shape.
 */
export function createValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    transformOptions: { enableImplicitConversion: false },
    exceptionFactory: (errors) => AppError.validation('Request validation failed', flatten(errors)),
  });
}
