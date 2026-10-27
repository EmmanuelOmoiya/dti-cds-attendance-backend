import { TEST_ENV } from './test-env';

// Runs in every integration/e2e worker before modules load. Redis is deliberately not configured:
// rate limiting falls back to in-memory storage, so tests do not depend on a Redis server.
delete process.env.REDIS_URL;
Object.assign(process.env, TEST_ENV);
