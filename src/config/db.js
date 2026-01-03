const prisma = require('../prismaClient');

/**
 * Simple Prisma/MySQL connectivity check used at server startup.
 * Returns true if the database connection is established, false otherwise.
 */
const connectDB = async () => {
  try {
    await prisma.$connect();
    console.log('MySQL connected via Prisma');
    return true;
  } catch (error) {
    console.error('MySQL connection failed via Prisma:', {
      message: error.message,
      code: error.code,
      stack: error.stack,
    });
    return false;
  }
};

module.exports = connectDB;
