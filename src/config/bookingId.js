const Counter = require('../models/Counter');

const generateBookingId = async () => {
  const counter = await Counter.findOneAndUpdate(
    { key: 'BOOKING' },
    { $inc: { seq: 1 } },
    { upsert: true, new: true }
  );
  // Produce 6‑digit numeric ID (100000–999999)
  const base = 100000 + (counter.seq % 900000);
  return String(base);
};

module.exports = generateBookingId;
