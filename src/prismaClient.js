// Backwards-compatible re-export of the central Prisma client.
// New code should prefer require('../config/prisma'), but existing
// imports from '../prismaClient' will continue to work.
const prisma = require('./config/prisma');

module.exports = prisma;
