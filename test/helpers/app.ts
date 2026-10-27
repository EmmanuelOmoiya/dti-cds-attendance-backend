import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import * as argon2 from 'argon2';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/app.setup';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { AppConfig } from '../../src/config/config.module';
import { Role } from '../../src/generated/prisma/client';

export interface TestApp {
  app: NestExpressApplication;
  prisma: PrismaService;
  http: () => ReturnType<typeof request>;
  close: () => Promise<void>;
}

/** Boots the real application (same HTTP pipeline as production) against the test database. */
export async function createTestApp(): Promise<TestApp> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
  configureApp(app, app.get(AppConfig));
  await app.init();
  const prisma = app.get(PrismaService);
  return {
    app,
    prisma,
    http: () => request(app.getHttpServer()),
    close: () => app.close(),
  };
}

const TABLES = [
  'AuditLog',
  'AttendanceRecord',
  'AttendanceEvent',
  'SyncEvent',
  'Device',
  'CardAssignment',
  'Card',
  'GroupMembership',
  'Member',
  'AttendanceSession',
  'CdsSchedule',
  'RefreshToken',
  'UserGroupScope',
  'User',
  'CdsGroup',
];

/** Empties every table (TRUNCATE bypasses the row-level no-delete triggers by design). */
export async function resetDb(prisma: PrismaService): Promise<void> {
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${TABLES.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`);
}

let cachedHash: string | undefined;
export const TEST_PASSWORD = 'Correct-Horse-1';

export async function createUser(prisma: PrismaService, opts: { email: string; role: Role; groupIds?: string[]; status?: 'ACTIVE' | 'DISABLED' }) {
  cachedHash ??= await argon2.hash(TEST_PASSWORD, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });
  return prisma.user.create({
    data: {
      email: opts.email,
      fullName: opts.email.split('@')[0],
      role: opts.role,
      status: opts.status ?? 'ACTIVE',
      passwordHash: cachedHash,
      groupScopes: { create: (opts.groupIds ?? []).map((groupId) => ({ groupId })) },
    },
  });
}

export async function login(t: TestApp, email: string, password = TEST_PASSWORD): Promise<string> {
  const res = await t.http().post('/api/v1/auth/login').send({ email, password });
  if (res.status !== 200) throw new Error(`login failed for ${email}: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.data.accessToken as string;
}

export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

export const minutes = (n: number) => n * 60_000;
export const hours = (n: number) => n * 3_600_000;
export const days = (n: number) => n * 86_400_000;
export const ago = (ms: number) => new Date(Date.now() - ms);
export const fromNow = (ms: number) => new Date(Date.now() + ms);
