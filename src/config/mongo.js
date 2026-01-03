const mongoose = require('mongoose');

/**
 * Connect to MongoDB for legacy Mongoose-based models (User, Order, etc.).
 * This runs alongside Prisma/MySQL during the migration period.
 */
const connectMongo = async () => {
  const uri = (process.env.MONGO_URI || process.env.MONGO_URI_LOCAL || '').trim();

  if (!uri) {
    console.warn('[MongoDB] No MONGO_URI configured, skipping Mongo connection');
    return;
  }

  try {
    await mongoose.connect(uri);
    console.log('[MongoDB] Connected successfully');
  } catch (err) {
    console.error('[MongoDB] Connection error:', {
      message: err.message,
      name: err.name,
    });
  }
};

module.exports = connectMongo;
