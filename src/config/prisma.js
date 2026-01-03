const { PrismaClient } = require('@prisma/client');

// Centralized Prisma client singleton for the whole app
// Use this module everywhere instead of instantiating PrismaClient directly.
const prisma = new PrismaClient();

module.exports = prisma;
