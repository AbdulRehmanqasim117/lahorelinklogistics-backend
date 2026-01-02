const Counter = require('../models/Counter');
const Order = require('../models/Order');

const generateTrackingId = async () => {
  for (let attempts = 0; attempts < 5; attempts++) {
    const counter = await Counter.findOneAndUpdate(
      { key: 'TRACKING' },
      { $inc: { seq: 1 } },
      { upsert: true, new: true }
    );
    // Produce 7‑digit numeric ID (1000000–9999999)
    const candidate = String(1000000 + (counter.seq % 9000000));
    const exists = await Order.findOne({ trackingId: candidate });
    if (!exists) return candidate;
  }
  // Fallback: last 7 digits of timestamp
  return String(Math.floor(Date.now() % 10000000)).padStart(7, '0');
};

module.exports = generateTrackingId;
