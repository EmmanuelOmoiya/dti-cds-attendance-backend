/**
 * Environment for integration/e2e tests. Points at the disposable `postgres-test` database
 * (docker compose, port 5433). Override with TEST_DATABASE_URL.
 */
export const TEST_ENV: Record<string, string> = {
  NODE_ENV: 'test',
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgresql://dti:dti_test_password@localhost:5433/dti_attendance_test?schema=public',
  JWT_ACCESS_SECRET: 'test-access-secret-0123456789-0123456789-abcdef',
  DEVICE_JWT_SECRET: 'test-device-secret-0123456789-0123456789-abcdef',
  LOG_LEVEL: 'silent',
  SWAGGER_ENABLED: 'false',
  JOBS_ENABLED: 'false',
  APP_TIMEZONE: 'Africa/Lagos',
  SESSION_GENERATION_HORIZON_WEEKS: '6',
  SESSION_EARLY_GRACE_MINUTES: '60',
  SESSION_CLOSE_GRACE_MINUTES: '30',
  SESSION_UNRESOLVED_AFTER_HOURS: '24',
  SYNC_MAX_BATCH_SIZE: '50',
  THROTTLE_DEFAULT_PER_MINUTE: '100000',
  THROTTLE_LOGIN_PER_MINUTE: '100000',
  THROTTLE_DEVICE_TOKEN_PER_MINUTE: '100000',
  THROTTLE_SYNC_PER_MINUTE: '100000',
};
