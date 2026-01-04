const connectDB = require('../src/config/db');
const Order = require('../src/models/Order');
const FinancialTransaction = require('../src/models/FinancialTransaction');
const RiderCommissionConfig = require('../src/models/RiderCommissionConfig');

const run = async () => {
  await connectDB();

  console.log('[BACKFILL_RIDER_EARNINGS] Starting backfill...');

  const cursor = Order.find({
    isDeleted: { $ne: true },
    assignedRider: { $ne: null },
    status: { $in: ['DELIVERED', 'RETURNED', 'FAILED'] },
  })
    .cursor();

  let processed = 0;
  let updated = 0;

  for (let order = await cursor.next(); order != null; order = await cursor.next()) {
    processed += 1;

    const normalizedStatus = String(order.status || '').trim().toUpperCase();
    const isDelivered = normalizedStatus === 'DELIVERED';

    const tx = await FinancialTransaction.findOne({ order: order._id });

    let riderEarning = Number(order.riderEarning || 0);
    if (!Number.isFinite(riderEarning) || riderEarning < 0) riderEarning = 0;

    if (riderEarning === 0) {
      // Prefer transaction.riderCommission when present
      if (tx && Number(tx.riderCommission || 0) > 0) {
        riderEarning = Number(tx.riderCommission || 0);
      } else {
        // Fallback to commission config (same logic as createFinancialTransaction)
        const riderCfg = await RiderCommissionConfig.findOne({ rider: order.assignedRider });
        if (riderCfg) {
          const collectedCod = isDelivered
            ? (order.amountCollected || order.codAmount || 0)
            : 0;
          const originalCod = Number(order.codAmount || 0);

          const rules = Array.isArray(riderCfg.rules) ? riderCfg.rules : [];
          const normalizedRules = rules.map((r) => ({
            ...r,
            _normalizedStatus: String(r.status || '').trim().toUpperCase(),
          }));

          const rule = normalizedRules.find((r) => r._normalizedStatus === normalizedStatus);

          const applyRule = (type, value, codBase) => {
            const numericValue = Number(value || 0);
            if (type === 'PERCENTAGE') {
              return (Number(codBase || 0) * numericValue) / 100;
            }
            return numericValue;
          };

          if (rule && rule.value !== undefined) {
            const codBase = isDelivered
              ? (order.amountCollected || order.codAmount || 0)
              : originalCod;
            const typeToUse = rule.type || riderCfg.type || 'FLAT';
            riderEarning = applyRule(typeToUse, rule.value, codBase);
          } else if (riderCfg.type && riderCfg.value !== undefined) {
            const codBase = isDelivered
              ? (order.amountCollected || order.codAmount || 0)
              : originalCod;
            riderEarning = applyRule(riderCfg.type, riderCfg.value, codBase);
          }

          // Clamp only for delivered orders
          if (isDelivered) {
            const codForClamp = Number(order.amountCollected || order.codAmount || 0);
            if (codForClamp > 0 && riderEarning > codForClamp) {
              riderEarning = codForClamp;
            }
          }

          if (!Number.isFinite(riderEarning) || riderEarning < 0) {
            riderEarning = 0;
          }
        }
      }
    }

    // Default settlement status for eligible orders without explicit status
    const normalizedSettlement = String(order.riderSettlementStatus || '').trim().toUpperCase();
    let riderSettlementStatus = normalizedSettlement;
    if (!riderSettlementStatus) {
      if (tx && tx.settlementStatus) {
        const txNorm = String(tx.settlementStatus || '').trim().toUpperCase();
        riderSettlementStatus = ['PAID', 'UNPAID'].includes(txNorm)
          ? txNorm
          : ['SETTLED'].includes(txNorm)
            ? 'PAID'
            : 'UNPAID';
      } else if (riderEarning > 0) {
        riderSettlementStatus = 'UNPAID';
      }
    }

    const update = {};
    if (riderEarning > 0 && riderEarning !== Number(order.riderEarning || 0)) {
      update.riderEarning = riderEarning;
    }
    if (riderSettlementStatus && riderSettlementStatus !== normalizedSettlement) {
      update.riderSettlementStatus = riderSettlementStatus;
    }

    if (Object.keys(update).length) {
      await Order.updateOne({ _id: order._id }, { $set: update });
      updated += 1;
    }

    if (processed % 100 === 0) {
      console.log('[BACKFILL_RIDER_EARNINGS] Progress', { processed, updated });
    }
  }

  console.log('[BACKFILL_RIDER_EARNINGS] Completed', { processed, updated });
  await mongoose.connection.close();
};

run().catch((err) => {
  console.error('[BACKFILL_RIDER_EARNINGS] Fatal error', err);
  process.exit(1);
});
