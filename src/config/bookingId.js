const prisma = require('../prismaClient');

const generateBookingId = async () => {
  // Use Prisma Counter table instead of Mongo Counter model
  const counter = await prisma.counter.upsert({
    where: { key: 'BOOKING' },
    update: { seq: { increment: 1 } },
    create: { key: 'BOOKING', seq: 1 },
  });

  // Produce 6‑digit numeric ID (100000–999999)
  const base = 100000 + (counter.seq % 900000);
  return String(base);
};

module.exports = generateBookingId;
