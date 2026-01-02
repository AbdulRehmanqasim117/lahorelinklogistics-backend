const mongoose = require('mongoose');
const Order = require('../models/Order');
const FinancialTransaction = require('../models/FinancialTransaction');
const RiderCommissionConfig = require('../models/RiderCommissionConfig');

// GET /api/rider/finance
// Rider self-finance view (only their own assigned orders)
exports.getMyFinance = async (req, res, next) => {
  try {
    const riderIdRaw = req.user.id || req.user._id;
    if (!riderIdRaw) {
      return res.status(401).json({ message: 'Unauthorized' });
    }
    const riderId = new mongoose.Types.ObjectId(String(riderIdRaw));

    const {
      from,
      to,
      status = 'all',
      sortOrder = 'desc',
      page = 1,
      limit = 20,
    } = req.query;

    const normalizedStatus = String(status || 'all').toLowerCase();
    const allowedFinalStatuses = ['DELIVERED', 'RETURNED', 'FAILED'];

    let statusMatch;
    if (normalizedStatus === 'delivered') {
      statusMatch = 'DELIVERED';
    } else if (normalizedStatus === 'returned') {
      statusMatch = 'RETURNED';
    } else if (normalizedStatus === 'failed') {
      statusMatch = 'FAILED';
    } else {
      statusMatch = { $in: allowedFinalStatuses };
    }

    const baseMatch = {
      assignedRider: riderId,
      status: statusMatch,
      isDeleted: { $ne: true },
    };

    // Date range filter (based on createdAt for simplicity/consistency with rider dashboard)
    const createdAtRange = {};
    if (from) {
      const d = new Date(from);
      d.setHours(0, 0, 0, 0);
      if (!Number.isNaN(d.getTime())) createdAtRange.$gte = d;
    }
    if (to) {
      const d = new Date(to);
      d.setHours(23, 59, 59, 999);
      if (!Number.isNaN(d.getTime())) createdAtRange.$lte = d;
    }
    if (Object.keys(createdAtRange).length) {
      baseMatch.createdAt = createdAtRange;
    }

    const pageNum = Math.max(1, Number(page) || 1);
    const limitNum = Math.min(100, Math.max(1, Number(limit) || 20));
    const sortDir = sortOrder === 'asc' ? 1 : -1;

    // Summary aggregation over ALL filtered orders (no pagination)
    const summaryMatch = { ...baseMatch };
    const summaryAgg = await Order.aggregate([
      { $match: summaryMatch },
      {
        $lookup: {
          from: 'financialtransactions',
          localField: '_id',
          foreignField: 'order',
          as: 'tx',
        },
      },
      {
        $unwind: { path: '$tx', preserveNullAndEmptyArrays: true },
      },
      {
        $addFields: {
          txSettlementStatus: { $toUpper: { $ifNull: ['$tx.settlementStatus', 'UNPAID'] } },
          effectiveSettlementStatus: {
            // Prefer order-level riderSettlementStatus when present; otherwise fall
            // back to the transaction settlement status (for legacy data).
            $let: {
              vars: {
                orderStatus: {
                  $toUpper: { $ifNull: ['$riderSettlementStatus', ''] },
                },
              },
              in: {
                $cond: [
                  { $in: ['$$orderStatus', ['PAID', 'UNPAID']] },
                  '$$orderStatus',
                  '$txSettlementStatus',
                ],
              },
            },
          },
          effectiveRiderEarning: {
            // Prefer order.riderEarning when non-zero; otherwise fall back to
            // transaction.riderCommission.
            $cond: [
              { $gt: [{ $ifNull: ['$riderEarning', 0] }, 0] },
              { $ifNull: ['$riderEarning', 0] },
              { $ifNull: ['$tx.riderCommission', 0] },
            ],
          },
        },
      },
      {
        $group: {
          _id: null,
          deliveredCount: {
            $sum: { $cond: [{ $eq: ['$status', 'DELIVERED'] }, 1, 0] },
          },
          returnedCount: {
            $sum: { $cond: [{ $eq: ['$status', 'RETURNED'] }, 1, 0] },
          },
          paidCount: {
            $sum: {
              $cond: [
                { $in: ['$effectiveSettlementStatus', ['PAID', 'SETTLED']] },
                1,
                0,
              ],
            },
          },
          unpaidCount: {
            $sum: {
              $cond: [
                { $in: ['$effectiveSettlementStatus', ['UNPAID', 'PENDING']] },
                1,
                0,
              ],
            },
          },
          codCollected: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $eq: ['$status', 'DELIVERED'] },
                    { $eq: ['$paymentType', 'COD'] },
                  ],
                },
                { $ifNull: ['$amountCollected', '$codAmount'] },
                0,
              ],
            },
          },
          serviceChargesTotal: {
            $sum: { $ifNull: ['$serviceCharges', 0] },
          },
          riderEarnings: {
            $sum: { $ifNull: ['$effectiveRiderEarning', 0] },
          },
          riderEarningsPaid: {
            $sum: {
              $cond: [
                { $in: ['$effectiveSettlementStatus', ['PAID', 'SETTLED']] },
                { $ifNull: ['$effectiveRiderEarning', 0] },
                0,
              ],
            },
          },
          riderEarningsUnpaid: {
            $sum: {
              $cond: [
                { $in: ['$effectiveSettlementStatus', ['UNPAID', 'PENDING']] },
                { $ifNull: ['$effectiveRiderEarning', 0] },
                0,
              ],
            },
          },
        },
      },
    ]);

    const summaryRow = summaryAgg[0] || {};
    const summary = summaryRow;

    // Unpaid balance = sum of riderCommission for PENDING transactions (all time)
    const unpaidAgg = await FinancialTransaction.aggregate([
      {
        $match: {
          rider: riderId,
          settlementStatus: { $in: ['UNPAID', 'PENDING'] },
        },
      },
      {
        $group: {
          _id: null,
          unpaidBalance: { $sum: { $ifNull: ['$riderCommission', 0] } },
        },
      },
    ]);
    const unpaidBalance = Number(unpaidAgg?.[0]?.unpaidBalance || 0);

    // Load rider commission configuration once for this rider to allow
    // fallback calculation for legacy transactions where riderCommission was
    // stored as 0 before logic was fixed.
    const riderCommissionConfig = await RiderCommissionConfig.findOne({
      rider: riderId,
    }).lean();

    // Paginated items
    const orderMatch = { ...baseMatch };

    const total = await Order.countDocuments(orderMatch);
    const orders = await Order.find(orderMatch)
      .populate('shipper', 'name companyName')
      .sort({ createdAt: sortDir })
      .skip((pageNum - 1) * limitNum)
      .limit(limitNum)
      .lean();

    const orderIds = orders.map((o) => o._id);
    const txs = orderIds.length
      ? await FinancialTransaction.find({
          order: { $in: orderIds },
          rider: riderId,
        })
          .lean()
      : [];

    const txByOrder = new Map(txs.map((tx) => [String(tx.order), tx]));

    const items = orders.map((o) => {
      const tx = txByOrder.get(String(o._id));
      let riderEarning = Number(
        o.riderEarning !== undefined && o.riderEarning !== null
          ? o.riderEarning
          : tx?.riderCommission || 0,
      );

      // Fallback: if there is no transaction/order earning or earning is 0,
      // try to compute rider earning from RiderCommissionConfig so that legacy
      // RETURNED/FAILED orders show the correct configured commission.
      if (((!tx && !o.riderEarning) || riderEarning === 0) && riderCommissionConfig) {
        const normalizedStatus = String(o.status || '').trim().toUpperCase();
        const isDeliveredOrder = normalizedStatus === 'DELIVERED';

        const collectedCodForOrder = isDeliveredOrder
          ? (o.amountCollected || o.codAmount || 0)
          : 0;
        const originalCodForOrder = Number(o.codAmount || 0);

        const rules = Array.isArray(riderCommissionConfig.rules)
          ? riderCommissionConfig.rules
          : [];
        const normalizedRules = rules.map((r) => ({
          ...r,
          _normalizedStatus: String(r.status || '').trim().toUpperCase(),
        }));

        const rule = normalizedRules.find(
          (r) => r._normalizedStatus === normalizedStatus,
        );

        const applyRule = (type, value, codBase) => {
          const numericValue = Number(value || 0);
          if (type === 'PERCENTAGE') {
            return (Number(codBase || 0) * numericValue) / 100;
          }
          return numericValue;
        };

        if (rule && rule.value !== undefined) {
          const codBase = isDeliveredOrder
            ? (o.amountCollected || o.codAmount || 0)
            : originalCodForOrder;
          const typeToUse = rule.type || riderCommissionConfig.type || 'FLAT';
          riderEarning = applyRule(typeToUse, rule.value, codBase);
        } else if (
          riderCommissionConfig.type &&
          riderCommissionConfig.value !== undefined
        ) {
          const codBase = isDeliveredOrder
            ? (o.amountCollected || o.codAmount || 0)
            : originalCodForOrder;
          riderEarning = applyRule(
            riderCommissionConfig.type,
            riderCommissionConfig.value,
            codBase,
          );
        }

        // Clamp only for delivered orders so commission does not exceed COD.
        if (isDeliveredOrder) {
          const codForClamp = Number(o.amountCollected || o.codAmount || 0);
          if (codForClamp > 0 && riderEarning > codForClamp) {
            riderEarning = codForClamp;
          }
        }

        if (!Number.isFinite(riderEarning) || riderEarning < 0) {
          riderEarning = 0;
        }
      }

      const normalizedOrderSettlement = String(o.riderSettlementStatus || '').toUpperCase();
      let settlementStatus;
      if (['PAID', 'UNPAID'].includes(normalizedOrderSettlement)) {
        settlementStatus = normalizedOrderSettlement === 'PAID' ? 'PAID' : 'UNPAID';
      } else {
        const normalizedTxStatus = String(tx?.settlementStatus || '').toUpperCase();
        settlementStatus = ['PAID', 'SETTLED'].includes(normalizedTxStatus)
          ? 'PAID'
          : 'UNPAID';
      }

      const date = o.deliveredAt || o.updatedAt || o.createdAt;
      const codAmount =
        o.status === 'DELIVERED'
          ? Number(o.amountCollected ?? o.codAmount ?? 0)
          : Number(o.codAmount ?? 0);

      return {
        id: o._id,
        orderId: o.bookingId,
        date,
        shipperName: o.shipper?.companyName || o.shipper?.name || '',
        destination: o.destinationCity,
        codAmount,
        serviceCharges: Number(o.serviceCharges || 0),
        riderEarning,
        status: o.status,
        settlementStatus,
        riderSettlementAt: o.riderSettlementAt,
        riderSettlementBy: o.riderSettlementBy,
      };
    });

    summary.unpaidBalance = unpaidBalance;

    res.json({
      summary: {
        deliveredCount: Number(summary.deliveredCount || 0),
        returnedCount: Number(summary.returnedCount || 0),
        failedCount: Number(summary.failedCount || 0),
        codCollected: Number(summary.codCollected || 0),
        serviceChargesTotal: Number(summary.serviceChargesTotal || 0),
        riderEarnings: Number(summary.riderEarnings || 0),
        riderEarningsPaid: Number(summary.riderEarningsPaid || 0),
        riderEarningsUnpaid: Number(summary.riderEarningsUnpaid || 0),
        unpaidBalance: Number(summary.unpaidBalance || 0),
      },
      items,
      page: pageNum,
      limit: limitNum,
      total,
      totalPages: Math.ceil(total / limitNum) || 0,
    });
  } catch (error) {
    next(error);
  }
};

// GET /api/riders/:id/settlements
// Admin (CEO/MANAGER) view of a specific rider's settlements with filters.
exports.getRiderSettlementsAdmin = async (req, res, next) => {
  try {
    const rawId = req.params.id;
    if (!rawId || !mongoose.isValidObjectId(String(rawId))) {
      return res.status(400).json({ message: 'Invalid rider id' });
    }

    const riderId = new mongoose.Types.ObjectId(String(rawId));

    const {
      from,
      to,
      status = 'all',
      settlement = 'all',
      sortOrder = 'desc',
      page = 1,
      limit = 20,
      shipperId,
      search,
    } = req.query;

    const normalizedStatus = String(status || 'all').toLowerCase();
    const allowedFinalStatuses = ['DELIVERED', 'RETURNED', 'FAILED'];

    let statusMatch;
    if (normalizedStatus === 'delivered') {
      statusMatch = 'DELIVERED';
    } else if (normalizedStatus === 'returned') {
      statusMatch = 'RETURNED';
    } else if (normalizedStatus === 'failed') {
      statusMatch = 'FAILED';
    } else {
      statusMatch = { $in: allowedFinalStatuses };
    }

    const baseMatch = {
      assignedRider: riderId,
      status: statusMatch,
      isDeleted: { $ne: true },
    };

    // Date range using the same "effective" order date as the Company
    // Ledger: for delivered orders use deliveredAt (falling back to
    // updatedAt), and for all other final statuses use updatedAt (falling
    // back to createdAt). This keeps Rider Settlements and Company
    // Finance in sync when using quick ranges like Today/7/30 days.
    if (from || to) {
      let rangeStart = null;
      let rangeEnd = null;

      if (from) {
        const d = new Date(from);
        d.setHours(0, 0, 0, 0);
        if (!Number.isNaN(d.getTime())) rangeStart = d;
      }
      if (to) {
        const d = new Date(to);
        d.setHours(23, 59, 59, 999);
        if (!Number.isNaN(d.getTime())) rangeEnd = d;
      }

      if (rangeStart || rangeEnd) {
        const effectiveDateExpr = {
          $cond: [
            { $eq: ['$status', 'DELIVERED'] },
            { $ifNull: ['$deliveredAt', '$updatedAt'] },
            { $ifNull: ['$updatedAt', '$createdAt'] },
          ],
        };

        const exprConds = [];
        if (rangeStart) {
          exprConds.push({ $gte: [effectiveDateExpr, rangeStart] });
        }
        if (rangeEnd) {
          exprConds.push({ $lte: [effectiveDateExpr, rangeEnd] });
        }

        if (exprConds.length === 1) {
          baseMatch.$expr = exprConds[0];
        } else if (exprConds.length > 1) {
          baseMatch.$expr = { $and: exprConds };
        }
      }
    }

    // Optional shipper filter
    if (shipperId && mongoose.isValidObjectId(String(shipperId))) {
      baseMatch.shipper = new mongoose.Types.ObjectId(String(shipperId));
    }

    // Settlement filter (order-level first, then implicit unpaid if null)
    const normalizedSettlement = String(settlement || 'all').toLowerCase();
    if (normalizedSettlement === 'paid') {
      baseMatch.riderSettlementStatus = 'PAID';
    } else if (normalizedSettlement === 'unpaid') {
      baseMatch.$or = [
        { riderSettlementStatus: 'UNPAID' },
        { riderSettlementStatus: null },
        { riderSettlementStatus: { $exists: false } },
      ];
    }

    // Search by bookingId / trackingId
    if (search && String(search).trim()) {
      const q = String(search).trim();
      baseMatch.$and = baseMatch.$and || [];
      baseMatch.$and.push({
        $or: [
          { bookingId: { $regex: q, $options: 'i' } },
          { trackingId: { $regex: q, $options: 'i' } },
        ],
      });
    }

    const pageNum = Math.max(1, Number(page) || 1);
    const limitNum = Math.min(100, Math.max(1, Number(limit) || 20));
    const sortDir = sortOrder === 'asc' ? 1 : -1;

    const total = await Order.countDocuments(baseMatch);
    const orders = await Order.find(baseMatch)
      .populate('shipper', 'name companyName')
      .sort({ createdAt: sortDir })
      .skip((pageNum - 1) * limitNum)
      .limit(limitNum)
      .lean();

    const orderIds = orders.map((o) => o._id);
    const txs = orderIds.length
      ? await FinancialTransaction.find({
          order: { $in: orderIds },
          rider: riderId,
        }).lean()
      : [];

    const txByOrder = new Map(txs.map((tx) => [String(tx.order), tx]));

    // Commission config for fallback earning calculation
    const riderCommissionConfig = await RiderCommissionConfig.findOne({
      rider: riderId,
    }).lean();

    const summary = {
      deliveredCount: 0,
      returnedCount: 0,
      failedCount: 0,
      codCollected: 0,
      serviceChargesTotal: 0,
      riderEarnings: 0,
      riderEarningsPaid: 0,
      riderEarningsUnpaid: 0,
      unpaidBalance: 0,
    };

    const items = orders.map((o) => {
      const tx = txByOrder.get(String(o._id));
      let riderEarning = Number(
        o.riderEarning !== undefined && o.riderEarning !== null
          ? o.riderEarning
          : tx?.riderCommission || 0,
      );

      // Same fallback logic as getMyFinance
      if (((!tx && !o.riderEarning) || riderEarning === 0) && riderCommissionConfig) {
        const normalizedStatusForOrder = String(o.status || '').trim().toUpperCase();
        const isDeliveredOrder = normalizedStatusForOrder === 'DELIVERED';

        const collectedCodForOrder = isDeliveredOrder
          ? (o.amountCollected || o.codAmount || 0)
          : 0;
        const originalCodForOrder = Number(o.codAmount || 0);

        const rules = Array.isArray(riderCommissionConfig.rules)
          ? riderCommissionConfig.rules
          : [];
        const normalizedRules = rules.map((r) => ({
          ...r,
          _normalizedStatus: String(r.status || '').trim().toUpperCase(),
        }));

        const rule = normalizedRules.find(
          (r) => r._normalizedStatus === normalizedStatusForOrder,
        );

        const applyRule = (type, value, codBase) => {
          const numericValue = Number(value || 0);
          if (type === 'PERCENTAGE') {
            return (Number(codBase || 0) * numericValue) / 100;
          }
          return numericValue;
        };

        if (rule && rule.value !== undefined) {
          const codBase = isDeliveredOrder
            ? (o.amountCollected || o.codAmount || 0)
            : originalCodForOrder;
          const typeToUse = rule.type || riderCommissionConfig.type || 'FLAT';
          riderEarning = applyRule(typeToUse, rule.value, codBase);
        } else if (
          riderCommissionConfig.type &&
          riderCommissionConfig.value !== undefined
        ) {
          const codBase = isDeliveredOrder
            ? (o.amountCollected || o.codAmount || 0)
            : originalCodForOrder;
          riderEarning = applyRule(
            riderCommissionConfig.type,
            riderCommissionConfig.value,
            codBase,
          );
        }

        if (isDeliveredOrder) {
          const codForClamp = Number(o.amountCollected || o.codAmount || 0);
          if (codForClamp > 0 && riderEarning > codForClamp) {
            riderEarning = codForClamp;
          }
        }
      }

      if (!Number.isFinite(riderEarning) || riderEarning < 0) {
        riderEarning = 0;
      }

      const normalizedOrderSettlement = String(o.riderSettlementStatus || '').toUpperCase();
      let settlementStatus;
      if (normalizedOrderSettlement === 'PAID' || normalizedOrderSettlement === 'UNPAID') {
        settlementStatus = normalizedOrderSettlement === 'PAID' ? 'PAID' : 'UNPAID';
      } else {
        const normalizedTxStatus = String(tx?.settlementStatus || '').toUpperCase();
        settlementStatus =
          normalizedTxStatus === 'PAID' || normalizedTxStatus === 'SETTLED'
            ? 'PAID'
            : 'UNPAID';
      }

      const date = o.deliveredAt || o.updatedAt || o.createdAt;
      const codAmount =
        o.status === 'DELIVERED'
          ? Number(o.amountCollected ?? o.codAmount ?? 0)
          : Number(o.codAmount ?? 0);

      const weightKg = Number(o.weightKg || 0);
      const snap = o.serviceChargesCalcSnapshot || {};
      const min =
        typeof snap.bracketMin === 'number' && Number.isFinite(snap.bracketMin)
          ? snap.bracketMin
          : null;
      const max =
        typeof snap.bracketMax === 'number' && Number.isFinite(snap.bracketMax)
          ? snap.bracketMax
          : null;

      const formatBracketValue = (v) => {
        if (v === null) return '';
        const rounded = Math.round(v * 10) / 10;
        return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
      };

      let weightBracketLabel = null;
      if (min !== null && max !== null) {
        weightBracketLabel = `${formatBracketValue(min)}–${formatBracketValue(max)}kg`;
      } else if (min !== null && max === null) {
        weightBracketLabel = `${formatBracketValue(min)}kg+`;
      } else if (min === null && max !== null) {
        weightBracketLabel = `0–${formatBracketValue(max)}kg`;
      }

      if (o.status === 'DELIVERED') {
        summary.deliveredCount += 1;
      } else if (o.status === 'RETURNED') {
        summary.returnedCount += 1;
      } else if (o.status === 'FAILED') {
        summary.failedCount += 1;
      }

      if (o.status === 'DELIVERED' && o.paymentType === 'COD') {
        summary.codCollected += codAmount;
      }

      summary.serviceChargesTotal += Number(o.serviceCharges || 0);
      summary.riderEarnings += riderEarning;
      if (settlementStatus === 'PAID') {
        summary.riderEarningsPaid += riderEarning;
      } else {
        summary.riderEarningsUnpaid += riderEarning;
      }

      return {
        id: o._id,
        orderId: o.bookingId,
        date,
        shipperName: o.shipper?.companyName || o.shipper?.name || '',
        consigneeName: o.consigneeName,
        consigneePhone: o.consigneePhone,
        destination: o.destinationCity,
        weightKg,
        weightBracketLabel,
        codAmount,
        serviceCharges: Number(o.serviceCharges || 0),
        riderEarning,
        status: o.status,
        settlementStatus,
        riderSettlementAt: o.riderSettlementAt,
        riderSettlementBy: o.riderSettlementBy,
      };
    });

    summary.unpaidBalance = summary.riderEarningsUnpaid;

    res.json({
      summary: {
        deliveredCount: Number(summary.deliveredCount || 0),
        returnedCount: Number(summary.returnedCount || 0),
        failedCount: Number(summary.failedCount || 0),
        codCollected: Number(summary.codCollected || 0),
        serviceChargesTotal: Number(summary.serviceChargesTotal || 0),
        riderEarnings: Number(summary.riderEarnings || 0),
        riderEarningsPaid: Number(summary.riderEarningsPaid || 0),
        riderEarningsUnpaid: Number(summary.riderEarningsUnpaid || 0),
        unpaidBalance: Number(summary.unpaidBalance || 0),
      },
      items,
      page: pageNum,
      limit: limitNum,
      total,
      totalPages: Math.ceil(total / limitNum) || 0,
    });
  } catch (error) {
    next(error);
  }
};
