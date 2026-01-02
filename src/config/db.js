const mongoose = require('mongoose');
mongoose.set('bufferCommands', false);

const connectDB = async () => {
  const primary = process.env.MONGO_URI;
  const fallback = process.env.MONGO_URI_LOCAL || 'mongodb://127.0.0.1:27017/lahore_link_logistics';

  const tryConnect = async (uri, label) => {
    try {
      const conn = await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
      console.log(`MongoDB Connected (${label}): ${conn.connection.host}`);
      return true;
    } catch (error) {
      console.error(`MongoDB connection failed (${label}): ${error.code || error.name} ${error.message}`);
      return false;
    }
  };

  let connected = false;
  if (primary) {
    connected = await tryConnect(primary, 'primary');
  }
  if (!connected) {
    connected = await tryConnect(fallback, 'local');
  }

  if (!connected) {
    console.error('Database connection not established. Server will continue running, endpoints may be unavailable until DB connects.');
    const retryIntervalMs = Number(process.env.DB_RETRY_MS || 10000);
    const timer = setInterval(async () => {
      let ok = false;
      if (primary) ok = await tryConnect(primary, 'primary');
      if (!ok) ok = await tryConnect(fallback, 'local');
      if (ok) {
        clearInterval(timer);
        console.log('MongoDB reconnected');
      }
    }, retryIntervalMs);
  }
  return connected;
};

module.exports = connectDB;
