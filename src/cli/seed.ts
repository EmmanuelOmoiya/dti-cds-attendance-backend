/**
 * Seed: creates the first SUPER_ADMIN (idempotent) and, with SEED_DEMO_DATA=true, a demo CDS
 * group with a weekly schedule, members, cards and an ACTIVE device.
 *
 *   npm run db:seed            (development, ts-node)
 *   npm run db:seed:prod       (compiled, e.g. inside the Docker image)
 *
 * Sessions are generated from the schedule by the API's maintenance job on startup.
 */
import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import * as argon2 from 'argon2';
import { createHash, randomBytes } from 'node:crypto';
import { PrismaClient, Role } from '../generated/prisma/client';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });

async function main(): Promise<void> {
  const email = (process.env.SEED_ADMIN_EMAIL ?? 'admin@dti.local').trim().toLowerCase();
  const password = process.env.SEED_ADMIN_PASSWORD;
  if (!password) {
    console.log('SEED_ADMIN_PASSWORD not set — seeding skipped');
    return;
  }
  if (password.length < 10) throw new Error('SEED_ADMIN_PASSWORD must be at least 10 characters');

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    console.log(`SUPER_ADMIN ${email} already exists — not modified`);
  } else {
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });
    const admin = await prisma.user.create({ data: { email, passwordHash, fullName: 'System Administrator', role: Role.SUPER_ADMIN } });
    await prisma.auditLog.create({ data: { actorType: 'SYSTEM', action: 'user.created', entityType: 'User', entityId: admin.id, metadata: { email, role: 'SUPER_ADMIN', via: 'seed' } } });
    console.log(`Created SUPER_ADMIN ${email}`);
  }

  if (process.env.SEED_DEMO_DATA === 'true') await seedDemo();
}

async function seedDemo(): Promise<void> {
  const name = 'DTI CDS Demo Group';
  if (await prisma.cdsGroup.findUnique({ where: { nameNormalized: name.toLowerCase() } })) {
    console.log('Demo data already present — skipped');
    return;
  }
  const today = new Date().toISOString().slice(0, 10);
  const group = await prisma.cdsGroup.create({ data: { name, nameNormalized: name.toLowerCase(), description: 'Demo data created by the seed script' } });
  await prisma.cdsSchedule.create({
    data: {
      groupId: group.id,
      title: 'Weekly DTI CDS meeting',
      dayOfWeek: 5,
      startLocalTime: '10:00',
      endLocalTime: '13:00',
      timezone: process.env.APP_TIMEZONE ?? 'Africa/Lagos',
      effectiveFrom: new Date(`${today}T00:00:00Z`),
    },
  });

  const members = [
    ['Adaeze Okafor', 'LA/25A/0001', '04A1B2C3D4E5F6'],
    ['Babatunde Adeyemi', 'LA/25A/0002', '04A1B2C3D4E5F7'],
    ['Chiamaka Eze', 'LA/25A/0003', '04A1B2C3D4E5F8'],
    ['Daniel Musa', 'LA/25A/0004', '04A1B2C3D4E5F9'],
    ['Esther Bello', 'LA/25A/0005', '04A1B2C3D4E5FA'],
  ] as const;
  const joinedAt = new Date();
  for (const [fullName, stateCode, cardUid] of members) {
    const member = await prisma.member.create({ data: { fullName, stateCode } });
    await prisma.groupMembership.create({ data: { memberId: member.id, groupId: group.id, joinedAt } });
    const card = await prisma.card.create({ data: { cardUid, status: 'ASSIGNED' } });
    await prisma.cardAssignment.create({ data: { cardId: card.id, memberId: member.id, assignedAt: joinedAt } });
  }
  for (const uid of ['04FFEEDDCCBB01', '04FFEEDDCCBB02']) await prisma.card.create({ data: { cardUid: uid } });

  const secret = `dsk_${randomBytes(32).toString('base64url')}`;
  const device = await prisma.device.create({
    data: {
      deviceIdentifier: 'DTI-DEMO-001',
      name: 'Demo reader',
      assignedGroupId: group.id,
      status: 'ACTIVE',
      activatedAt: new Date(),
      secretHash: createHash('sha256').update(secret).digest('hex'),
    },
  });
  console.log('Demo data created:');
  console.log(`  group     ${group.name} (${group.id})`);
  console.log(`  device    ${device.deviceIdentifier}  secret: ${secret}`);
  console.log('  (the device secret is printed once — store it now)');
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
