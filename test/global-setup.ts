import { execSync } from 'node:child_process';
import { TEST_ENV } from './test-env';

/** Applies all migrations (including the hand-written constraint migration) to the test database. */
export default function globalSetup(): void {
  execSync('npx prisma migrate deploy', {
    stdio: 'pipe',
    env: { ...process.env, DATABASE_URL: TEST_ENV.DATABASE_URL },
  });
}
