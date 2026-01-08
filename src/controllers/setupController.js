const bcrypt = require('bcryptjs');
const prisma = require('../prismaClient');

// Helper: check if initial CEO setup is already completed
async function isInitialSetupDone() {
  // DB-level guard using SystemSetting
  const setting = await prisma.systemSetting.findUnique({
    where: { key: 'INITIAL_SETUP_DONE' },
  });
  if (setting && setting.value === 'true') {
    return true;
  }

  // Fallback: if any CEO user exists, treat setup as done
  const existingCeo = await prisma.user.findFirst({ where: { role: 'CEO' } });
  return !!existingCeo;
}

exports.createInitialCeo = async (req, res, next) => {
  try {
    const setupEnabled = process.env.SETUP_ENABLED === 'true';
    const setupKey = process.env.SETUP_KEY || '';

    if (!setupEnabled) {
      return res.status(403).json({ message: 'Initial setup is disabled.' });
    }

    const headerKey = req.headers['x-setup-key'];
    if (!headerKey || headerKey !== setupKey) {
      return res.status(401).json({ message: 'Invalid setup key.' });
    }

    if (await isInitialSetupDone()) {
      return res
        .status(409)
        .json({ message: 'Setup already completed.' });
    }

    const { email, password, name } = req.body || {};

    // Basic validation
    if (!email || !password) {
      return res
        .status(400)
        .json({ message: 'Email and password are required.' });
    }

    if (typeof email !== 'string' || !email.includes('@')) {
      return res.status(400).json({ message: 'Invalid email.' });
    }

    if (typeof password !== 'string' || password.length < 8) {
      return res
        .status(400)
        .json({ message: 'Password must be at least 8 characters.' });
    }

    // Ensure email is not already used
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      return res
        .status(409)
        .json({ message: 'A user with this email already exists.' });
    }

    // Create CEO user with hashed password
    const passwordHash = await bcrypt.hash(password, 10);

    await prisma.$transaction(async (tx) => {
      await tx.user.create({
        data: {
          name: name || 'CEO',
          email,
          passwordHash,
          role: 'CEO',
          status: 'ACTIVE',
        },
      });

      await tx.systemSetting.upsert({
        where: { key: 'INITIAL_SETUP_DONE' },
        update: { value: 'true' },
        create: { key: 'INITIAL_SETUP_DONE', value: 'true' },
      });
    });

    // Do not log or return credentials
    console.log('[setup] Initial CEO account created via setup endpoint');

    return res.json({
      ok: true,
      message:
        'CEO created. Disable SETUP_ENABLED in environment configuration now.',
    });
  } catch (err) {
    console.error('[setup] Error during initial CEO setup:', err.message);
    return next(err);
  }
};
