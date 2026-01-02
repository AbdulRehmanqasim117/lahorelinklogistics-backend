const mongoose = require('mongoose');
const connectDB = require('../src/config/db');
const Order = require('../src/models/Order');
const FinancialTransaction = require('../src/models/FinancialTransaction');

const allowedFinalStatuses = ['DELIVERED', 'RETURNED', 'FAILED'];

const normalizeStatus = (value) => String(value || '').trim().toUpperCase();

const run = async () => {
  await connectDB();

  try {
    const [riderIdArg, fromArg, toArg] = process.argv.slice(2);

    if (!riderIdArg || !mongoose.isValidObjectId(String(riderIdArg))) {
      console.error('Usage: node scripts/inspectRiderFinanceWindow.js <riderId> [fromYYYY-MM-DD] [toYYYY-MM-DD]');
      process.exit(1);
    }

    const riderId = new mongoose.Types.ObjectId(String(riderIdArg));

    let rangeStart = null;
    let rangeEnd = null;
    if (fromArg) {
      const d = new Date(fromArg);
      d.setHours(0, 0, 0, 0);
      if (!Number.isNaN(d.getTime())) rangeStart = d;
    }
    if (toArg) {
      const d = new Date(toArg);
      d.setHours(23, 59, 59, 999);
      if (!Number.isNaN(d.getTime())) rangeEnd = d;
    }

    const baseMatch = {
      assignedRider: riderId,
      status: { $in: allowedFinalStatuses },
      isDeleted: { $ne: true },
    };

    const orders = await Order.find(baseMatch).lean();
    const orderIds = orders.map((o) => o._id);
    const txs = orderIds.length
      ? await FinancialTransaction.find({ order: { $in: orderIds }, rider: riderId }).lean()
      : [];
    const txByOrder = new Map(txs.map((tx) => [String(tx.order), tx]));

    const summary = {
      totalOrders: 0,
      deliveredCount: 0,
      returnedCount: 0,
      failedCount: 0,
      totalCod: 0,
      totalServiceCharges: 0,
      riderEarningsTotal: 0,
      riderEarningsPaid: 0,
      riderEarningsUnpaid: 0,
    };

    const windowLabel = {
      from: rangeStart ? rangeStart.toISOString() : null,
      to: rangeEnd ? rangeEnd.toISOString() : null,
    };

    for (const o of orders) {
      const tx = txByOrder.get(String(o._id));

      const normalizedStatus = normalizeStatus(o.status);
      if (!allowedFinalStatuses.includes(normalizedStatus)) continue;

      // Effective date identical to Company Ledger / Rider Settlements admin
      const effectiveDate =
        normalizedStatus === 'DELIVERED'
          ? (o.deliveredAt || o.updatedAt || o.createdAt)
          : (o.updatedAt || o.createdAt);

      if (!effectiveDate) continue;
      if (rangeStart && effectiveDate < rangeStart) continue;
      if (rangeEnd && effectiveDate > rangeEnd) continue;

      summary.totalOrders += 1;
      if (normalizedStatus === 'DELIVERED') summary.deliveredCount += 1;
      else if (normalizedStatus === 'RETURNED') summary.returnedCount += 1;
      else if (normalizedStatus === 'FAILED') summary.failedCount += 1;

      const cod =
        normalizedStatus === 'DELIVERED'
          ? Number(o.amountCollected ?? o.codAmount ?? 0)
          : Number(o.codAmount ?? 0);
      const serviceCharges = Number(o.serviceCharges || 0);

      summary.totalCod += cod;
      summary.totalServiceCharges += serviceCharges;

      // Rider earning: same precedence as company ledger summary/ledger.
      let riderEarning = Number(
        o.riderEarning !== undefined && o.riderEarning !== null
          ? o.riderEarning
          : tx?.riderCommission || 0,
      );
      if (!Number.isFinite(riderEarning) || riderEarning < 0) riderEarning = 0;

      const normalizedOrderSettlement = normalizeStatus(o.riderSettlementStatus);
      let settlementStatus;
      if (normalizedOrderSettlement === 'PAID' || normalizedOrderSettlement === 'UNPAID') {
        settlementStatus = normalizedOrderSettlement;
      } else {
        const txStatus = normalizeStatus(tx?.settlementStatus);
        if (txStatus === 'PAID' || txStatus === 'SETTLED') settlementStatus = 'PAID';
        else settlementStatus = 'UNPAID';
      }

      summary.riderEarningsTotal += riderEarning;
      if (settlementStatus === 'PAID') {
        summary.riderEarningsPaid += riderEarning;
      } else {
        summary.riderEarningsUnpaid += riderEarning;
      }
    }

    console.log('[INSPECT_RIDER_FINANCE_WINDOW] Summary', {
      riderId: String(riderIdArg),
      window: windowLabel,
      summary,
    });
  } catch (err) {
    console.error('[INSPECT_RIDER_FINANCE_WINDOW] Error', err);
  } finally {
    await mongoose.connection.close();
  }
};

run().catch((err) => {
  console.error('[INSPECT_RIDER_FINANCE_WINDOW] Fatal error', err);
  process.exit(1);
});
