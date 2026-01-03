const path = require('path');
const bcrypt = require('bcryptjs');
const { PrismaClient } = require('@prisma/client');

// Load environment variables from server/.env
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const prisma = new PrismaClient();

async function seedAdminUsers() {
  const CEO_EMAIL = (process.env.CEO_EMAIL || '').trim();
  const CEO_PASSWORD = (process.env.CEO_PASSWORD || '').trim();
  const MANAGER_EMAIL = (process.env.MANAGER_EMAIL || '').trim();
  const MANAGER_PASSWORD = (process.env.MANAGER_PASSWORD || '').trim();

  const HAS_ADMIN_SEED_ENVS =
    !!CEO_EMAIL && !!CEO_PASSWORD && !!MANAGER_EMAIL && !!MANAGER_PASSWORD;

  if (!HAS_ADMIN_SEED_ENVS) {
    console.warn(
      '[seed] CEO or Manager credentials missing in environment variables; admin accounts will not be auto-seeded',
    );
    return;
  }

  // CEO
  let ceo = await prisma.user.findFirst({
    where: {
      OR: [
        { role: 'CEO' },
        { email: CEO_EMAIL },
      ],
    },
  });

  if (!ceo) {
    const hash = await bcrypt.hash(CEO_PASSWORD, 10);
    ceo = await prisma.user.create({
      data: {
        name: 'CEO',
        email: CEO_EMAIL,
        passwordHash: hash,
        role: 'CEO',
        status: 'ACTIVE',
      },
    });
    console.log('[seed] Seeded CEO account');
  } else {
    const updates = {};

    if (ceo.role !== 'CEO') {
      updates.role = 'CEO';
    }
    if (ceo.email !== CEO_EMAIL) {
      updates.email = CEO_EMAIL;
    }

    let ceoPasswordOk = false;
    if (ceo.passwordHash) {
      try {
        ceoPasswordOk = await bcrypt.compare(CEO_PASSWORD, ceo.passwordHash);
      } catch (_) {
        ceoPasswordOk = false;
      }
    }
    if (!ceoPasswordOk) {
      updates.passwordHash = await bcrypt.hash(CEO_PASSWORD, 10);
    }

    if (Object.keys(updates).length > 0) {
      await prisma.user.update({ where: { id: ceo.id }, data: updates });
      console.log('[seed] Updated existing CEO account');
    } else {
      console.log('[seed] CEO account already up-to-date');
    }
  }

  // Manager
  let manager = await prisma.user.findFirst({
    where: {
      OR: [
        { role: 'MANAGER' },
        { email: MANAGER_EMAIL },
      ],
    },
  });

  if (!manager) {
    const hash = await bcrypt.hash(MANAGER_PASSWORD, 10);
    manager = await prisma.user.create({
      data: {
        name: 'Manager',
        email: MANAGER_EMAIL,
        passwordHash: hash,
        role: 'MANAGER',
        status: 'ACTIVE',
      },
    });
    console.log('[seed] Seeded Manager account');
  } else {
    const updates = {};

    if (manager.role !== 'MANAGER') {
      updates.role = 'MANAGER';
    }
    if (manager.email !== MANAGER_EMAIL) {
      updates.email = MANAGER_EMAIL;
    }

    let managerPasswordOk = false;
    if (manager.passwordHash) {
      try {
        managerPasswordOk = await bcrypt.compare(
          MANAGER_PASSWORD,
          manager.passwordHash,
        );
      } catch (_) {
        managerPasswordOk = false;
      }
    }
    if (!managerPasswordOk) {
      updates.passwordHash = await bcrypt.hash(MANAGER_PASSWORD, 10);
    }

    if (Object.keys(updates).length > 0) {
      await prisma.user.update({ where: { id: manager.id }, data: updates });
      console.log('[seed] Updated existing Manager account');
    } else {
      console.log('[seed] Manager account already up-to-date');
    }
  }
}

async function main() {
  try {
    await seedAdminUsers();
  } catch (err) {
    console.error('[seed] Error while seeding admin users:', err);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

main();
