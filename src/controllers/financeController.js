const mongoose = require('mongoose');
const FinancialTransaction = require('../models/FinancialTransaction');
const Order = require('../models/Order');
const User = require('../models/User');
const FinancePeriod = require('../models/FinancePeriod');

async function getOrCreateActiveFinancePeriod(userId) {
  // Try to find the most recent OPEN period
  let period = await FinancePeriod.findOne({ status: 'OPEN' }).sort({ periodStart: -1 });
  if (period) return period;

  // If none exists, create one starting from the first day of the current month
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  period = await FinancePeriod.create({ periodStart: start, status: 'OPEN' });
  return period;
}

function parseDateInput(raw) {
  if (!raw) return null;
  const value = String(raw).trim();
  if (!value) return null;

  // Explicit YYYY-MM-DD (HTML date input / ISO-like)
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [y, m, d] = value.split('-').map((v) => parseInt(v, 10));
    const dt = new Date(y, m - 1, d);
    return Number.isNaN(dt.getTime()) ? null : dt;
  }

  // Explicit MM/DD/YYYY support (e.g. 12/26/2025)
  if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(value)) {
    const [mm, dd, yyyy] = value.split('/').map((v) => parseInt(v, 10));
    const dt = new Date(yyyy, mm - 1, dd);
    return Number.isNaN(dt.getTime()) ? null : dt;
  }

  const dt = new Date(value);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

function buildDateRangeFromQuery(rangeRaw, fromRaw, toRaw) {
  const result = { start: null, end: null };

  const fromDate = parseDateInput(fromRaw);
  const toDate = parseDateInput(toRaw);

  if (fromDate || toDate) {
    if (fromDate) {
      fromDate.setHours(0, 0, 0, 0);
      result.start = fromDate;
    }
    if (toDate) {
      toDate.setHours(23, 59, 59, 999);
      result.end = toDate;
    }
    return result;
  }

  const rangeKey = String(rangeRaw || '').toLowerCase();
  if (!rangeKey || rangeKey === 'all' || rangeKey === 'custom') {
    return result;
  }

  const now = new Date();
  const end = new Date(now);
  end.setHours(23, 59, 59, 999);
  let start = new Date(now);
  start.setHours(0, 0, 0, 0);

  let days = 0;
  if (rangeKey === 'today') {
    days = 1;
  } else if (rangeKey === '7' || rangeKey === '7d') {
    days = 7;
  } else if (rangeKey === '15' || rangeKey === '15d') {
    days = 15;
  } else if (rangeKey === '30' || rangeKey === '30d') {
    days = 30;
  }

  if (days <= 1) {
    result.start = start;
    result.end = end;
    return result;
  }

  start = new Date(end);
  start.setDate(start.getDate() - (days - 1));
  start.setHours(0, 0, 0, 0);

  result.start = start;
  result.end = end;
  return result;
}

function buildOrderFiltersFromQuery(query) {
  const {
    range = 'all',
    from,
    to,
    shipperId,
    riderId,
    shipper,
    rider,
  } = query || {};

  const baseMatch = {
    paymentType: 'COD',
    isDeleted: { $ne: true },
    status: { $in: ['DELIVERED', 'RETURNED', 'FAILED'] },
  };

  const shipperFilter = shipperId || shipper;
  if (shipperFilter && mongoose.isValidObjectId(String(shipperFilter))) {
    baseMatch.shipper = new mongoose.Types.ObjectId(String(shipperFilter));
  }

  const riderFilter = riderId || rider;
  if (riderFilter && mongoose.isValidObjectId(String(riderFilter))) {
    baseMatch.assignedRider = new mongoose.Types.ObjectId(String(riderFilter));
  }

  const dateRange = buildDateRangeFromQuery(range, from, to);

  return {
    baseMatch,
    dateRange,
    range,
    from,
    to,
    shipperId: shipperFilter || null,
    riderId: riderFilter || null,
  };
}

function buildOrdersAggregationBase(orderMatch, dateRange) {
  const pipeline = [
    { $match: orderMatch },
    {
      $addFields: {
        effectiveDate: {
          $cond: [
            { $ifNull: ['$deliveredAt', false] },
            '$deliveredAt',
            '$createdAt',
          ],
        },
      },
    },
  ];

  if (dateRange && (dateRange.start || dateRange.end)) {
    const dateMatch = {};
    if (dateRange.start) dateMatch.$gte = dateRange.start;
    if (dateRange.end) dateMatch.$lte = dateRange.end;
    pipeline.push({ $match: { effectiveDate: dateMatch } });
  }

  return pipeline;
}

exports.getShipperSummary = async (req, res, next) => {
  try {
    const activePeriod = await getOrCreateActiveFinancePeriod(req.user && req.user.id);

    const match = {};
    if (activePeriod && activePeriod.periodStart) {
      const range = { $gte: activePeriod.periodStart };
      const end = activePeriod.periodEnd || new Date();
      range.$lte = end;
      match.createdAt = range;
    }

    const summary = await FinancialTransaction.aggregate([
      { $match: match },
      {
        $group: {
          _id: "$shipper",
          totalCodCollected: { $sum: "$totalCodCollected" },
          totalShipperShare: { $sum: "$shipperShare" },
          totalCompanyCommission: { $sum: "$companyCommission" },
          ordersCount: { $sum: 1 }
        }
      },
      {
        $lookup: {
          from: "users",
          localField: "_id",
          foreignField: "_id",
          as: "shipperDetails"
        }
      },
      {
        $unwind: "$shipperDetails"
      },
      {
        $project: {
          shipperName: "$shipperDetails.name",
          shipperEmail: "$shipperDetails.email",
          totalCodCollected: 1,
          totalShipperShare: 1,
          totalCompanyCommission: 1,
          ordersCount: 1
        }
      }
    ]);

    res.json(summary);
  } catch (error) {
    next(error);
  }
};

exports.getTransactionByOrder = async (req, res, next) => {
  try {
    const { orderId } = req.params;
    const tx = await FinancialTransaction.findOne({ order: orderId });
    if (!tx) return res.status(404).json({ message: 'Transaction not found' });

    const role = req.user.role;
    const uid = req.user.id;
    if (role === 'SHIPPER' && tx.shipper?.toString() !== uid) {
      return res.status(403).json({ message: 'Forbidden' });
    }
    if (role === 'RIDER' && tx.rider?.toString() !== uid) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    res.json(tx);
  } catch (error) {
    next(error);
  }
};

exports.getRiderSummary = async (req, res, next) => {
  try {
    const activePeriod = await getOrCreateActiveFinancePeriod(req.user && req.user.id);

    const match = {};
    if (activePeriod && activePeriod.periodStart) {
      const range = { $gte: activePeriod.periodStart };
      const end = activePeriod.periodEnd || new Date();
      range.$lte = end;
      match.createdAt = range;
    }

    const summary = await FinancialTransaction.aggregate([
      { $match: match },
      {
        $group: {
          _id: "$rider",
          totalCodCollected: { $sum: "$totalCodCollected" },
          deliveredCount: { $sum: 1 },
          pendingSettlements: {
            $sum: { $cond: [{ $eq: ["$settlementStatus", "PENDING"] }, 1, 0] }
          },
          settledTransactions: {
            $sum: { $cond: [{ $eq: ["$settlementStatus", "SETTLED"] }, 1, 0] }
          }
        }
      },
      {
        $lookup: {
          from: "users",
          localField: "_id",
          foreignField: "_id",
          as: "riderDetails"
        }
      },
      {
        $unwind: { path: "$riderDetails", preserveNullAndEmptyArrays: true }
      },
      {
        $project: {
          riderName: { $ifNull: ["$riderDetails.name", "Unassigned"] },
          totalCodCollected: 1,
          deliveredCount: 1,
          pendingSettlements: 1,
          settledTransactions: 1
        }
      }
    ]);

    res.json(summary);
  } catch (error) {
    next(error);
  }
};

exports.settleTransaction = async (req, res, next) => {
  try {
    const { id } = req.params;
    
    const transaction = await FinancialTransaction.findByIdAndUpdate(
      id,
      { settlementStatus: 'SETTLED' },
      { new: true }
    );

    if (!transaction) {
      return res.status(404).json({ message: 'Transaction not found' });
    }

    res.json(transaction);
  } catch (error) {
    next(error);
  }
};

exports.getMyRiderSummary = async (req, res, next) => {
  try {
    const riderId = req.user.id;

    const todayStr = new Date().toDateString();
    const transactions = await FinancialTransaction.find({ rider: riderId }).sort({ createdAt: -1 });

    const totals = transactions.reduce((acc, t) => {
      acc.totalCodCollected += Number(t.totalCodCollected || 0);
      if (new Date(t.createdAt).toDateString() === todayStr) {
        acc.todayCodCollected += Number(t.totalCodCollected || 0);
      }
      if (t.settlementStatus === 'PENDING') acc.pendingCount += 1;
      if (t.settlementStatus === 'SETTLED') acc.settledCount += 1;
      return acc;
    }, { totalCodCollected: 0, todayCodCollected: 0, pendingCount: 0, settledCount: 0 });

    res.json({ totals, transactions });
  } catch (error) {
    next(error);
  }
};

exports.getMyShipperSummary = async (req, res, next) => {
  try {
    console.log('DEBUG getMyShipperSummary req.user:', req.user);
    const shipperId = req.user.id;
    console.log('DEBUG getMyShipperSummary shipperId:', shipperId);
    if (!shipperId) {
      console.log('DEBUG getMyShipperSummary NO SHIPPER ID!');
      return res.status(401).json({ message: 'Unauthorized' });
    }
    const transactions = await FinancialTransaction.find({ shipper: shipperId }).sort({ createdAt: -1 });
    console.log('DEBUG getMyShipperSummary found transactions:', transactions.length);
    const totals = transactions.reduce((acc, t) => {
      acc.totalCodCollected += Number(t.totalCodCollected || 0);
      acc.totalCompanyCommission += Number(t.companyCommission || 0);
      acc.totalShipperShare += Number(t.shipperShare || 0);
      return acc;
    }, { totalCodCollected: 0, totalCompanyCommission: 0, totalShipperShare: 0 });
    console.log('DEBUG getMyShipperSummary response:', { totals, transactionCount: transactions.length });
    res.json({ totals, transactions });
  } catch (error) {
    console.error('DEBUG getMyShipperSummary error:', error.message, error.stack);
    next(error);
  }
};

exports.setRiderSettlementByOrder = async (req, res, next) => {
  try {
    const { id } = req.params; // orderId

    const tx = await FinancialTransaction.findOne({ order: id });
    if (!tx) {
      return res.status(404).json({ message: 'Transaction not found for this order' });
    }

    const rawStatus = (req.body && req.body.status) || (req.body && req.body.settlementStatus);
    const normalizedStatus = String(rawStatus || '').trim().toUpperCase();

    let settlementStatus;
    if (normalizedStatus === 'UNPAID') {
      settlementStatus = 'UNPAID';
    } else if (normalizedStatus === 'PENDING') {
      settlementStatus = 'PENDING';
    } else if (normalizedStatus === 'SETTLED') {
      settlementStatus = 'SETTLED';
    } else if (normalizedStatus === 'PAID') {
      settlementStatus = 'PAID';
    } else {
      // Default: mark as PAID if no/unknown status is provided
      settlementStatus = 'PAID';
    }

    const update = {
      settlementStatus,
    };

    if (settlementStatus === 'PAID' || settlementStatus === 'SETTLED') {
      update.paidAt = new Date();
      update.paidBy = req.user.id || req.user._id;
    } else {
      update.paidAt = null;
      update.paidBy = null;
    }

    const updated = await FinancialTransaction.findByIdAndUpdate(tx._id, update, {
      new: true,
    });

    res.json(updated);
  } catch (error) {
    next(error);
  }
};

// Company finance summary for CEO/Manager
// GET /api/finance/company/summary
exports.getCompanyFinanceSummary = async (req, res, next) => {
  try {
    const filters = buildOrderFiltersFromQuery(req.query);

    const pipeline = buildOrdersAggregationBase(filters.baseMatch, filters.dateRange);

    pipeline.push(
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
          effectiveStatus: { $toUpper: '$status' },
          codEffective: {
            $cond: [
              {
                $and: [
                  { $eq: ['$paymentType', 'COD'] },
                  { $eq: ['$status', 'DELIVERED'] },
                ],
              },
              { $ifNull: ['$amountCollected', '$codAmount'] },
              0,
            ],
          },
          serviceChargesEff: { $ifNull: ['$serviceCharges', 0] },
          riderPaid: {
            $cond: [
              { $gt: [{ $ifNull: ['$tx.riderCommission', 0] }, 0] },
              { $ifNull: ['$tx.riderCommission', 0] },
              { $ifNull: ['$riderEarning', 0] },
            ],
          },
          companyCommissionEff: { $ifNull: ['$tx.companyCommission', 0] },
          hasCompanyCommission: {
            $gt: [{ $ifNull: ['$tx.companyCommission', 0] }, 0],
          },
          settlementStatusEff: {
            $toUpper: { $ifNull: ['$tx.settlementStatus', 'UNPAID'] },
          },
        },
      },
      {
        $group: {
          _id: null,
          ordersCount: { $sum: 1 },
          totalCod: { $sum: { $ifNull: ['$codEffective', 0] } },
          totalServiceCharges: { $sum: '$serviceChargesEff' },
          totalRiderPaid: { $sum: '$riderPaid' },
          totalCompanyCommission: { $sum: '$companyCommissionEff' },
          deliveredOrders: {
            $sum: { $cond: [{ $eq: ['$effectiveStatus', 'DELIVERED'] }, 1, 0] },
          },
          returnedOrders: {
            $sum: { $cond: [{ $eq: ['$effectiveStatus', 'RETURNED'] }, 1, 0] },
          },
          pendingRiderSettlementsCount: {
            $sum: {
              $cond: [
                { $in: ['$settlementStatusEff', ['UNPAID', 'PENDING']] },
                1,
                0,
              ],
            },
          },
          pendingRiderSettlementsAmount: {
            $sum: {
              $cond: [
                { $in: ['$settlementStatusEff', ['UNPAID', 'PENDING']] },
                { $ifNull: ['$riderPaid', 0] },
                0,
              ],
            },
          },
          settledRiderTransactionsCount: {
            $sum: {
              $cond: [
                { $in: ['$settlementStatusEff', ['PAID', 'SETTLED']] },
                1,
                0,
              ],
            },
          },
          profitUsingCommission: {
            $sum: {
              $cond: [
                '$hasCompanyCommission',
                { $subtract: ['$companyCommissionEff', '$riderPaid'] },
                0,
              ],
            },
          },
          profitUsingServiceCharges: {
            $sum: {
              $cond: [
                { $not: ['$hasCompanyCommission'] },
                { $subtract: ['$serviceChargesEff', '$riderPaid'] },
                0,
              ],
            },
          },
        },
      },
    );

    const agg = await Order.aggregate(pipeline);
    const row = agg[0] || {};

    const totalCod = Number(row.totalCod || 0);
    const totalServiceCharges = Number(row.totalServiceCharges || 0);
    const totalAmount = totalCod + totalServiceCharges;
    const companyProfit =
      Number(row.profitUsingCommission || 0) +
      Number(row.profitUsingServiceCharges || 0);
    const unpaidRiderBalances = Number(row.pendingRiderSettlementsAmount || 0);

    res.json({
      filters: {
        range: filters.range,
        from: filters.from || null,
        to: filters.to || null,
        shipperId: filters.shipperId,
        riderId: filters.riderId,
      },
      metrics: {
        ordersCount: Number(row.ordersCount || 0),
        totalCod,
        totalServiceCharges,
        totalAmount,
        deliveredOrders: Number(row.deliveredOrders || 0),
        returnedOrders: Number(row.returnedOrders || 0),
        pendingRiderSettlementsCount: Number(
          row.pendingRiderSettlementsCount || 0,
        ),
        pendingRiderSettlementsAmount: unpaidRiderBalances,
        settledRiderTransactionsCount: Number(
          row.settledRiderTransactionsCount || 0,
        ),
        unpaidRiderBalances,
        totalRiderPaid: Number(row.totalRiderPaid || 0),
        totalCompanyCommission: Number(row.totalCompanyCommission || 0),
        companyProfit,
      },
    });
  } catch (error) {
    next(error);
  }
};

// Company-wide ledger for CEO/Manager
// GET /api/finance/company/ledger
exports.getCompanyLedger = async (req, res, next) => {
  try {
    const activePeriod = await getOrCreateActiveFinancePeriod(
      req.user && req.user.id,
    );

    const filters = buildOrderFiltersFromQuery(req.query);
    const pipeline = buildOrdersAggregationBase(
      filters.baseMatch,
      filters.dateRange,
    );

    pipeline.push(
      {
        $lookup: {
          from: 'users',
          localField: 'shipper',
          foreignField: '_id',
          as: 'shipperDoc',
        },
      },
      {
        $unwind: { path: '$shipperDoc', preserveNullAndEmptyArrays: true },
      },
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
          effectiveStatus: { $toUpper: '$status' },
          codEffective: {
            $cond: [
              {
                $and: [
                  { $eq: ['$paymentType', 'COD'] },
                  { $eq: ['$status', 'DELIVERED'] },
                ],
              },
              { $ifNull: ['$amountCollected', '$codAmount'] },
              0,
            ],
          },
          serviceChargesEff: { $ifNull: ['$serviceCharges', 0] },
          riderPaid: {
            $cond: [
              { $gt: [{ $ifNull: ['$tx.riderCommission', 0] }, 0] },
              { $ifNull: ['$tx.riderCommission', 0] },
              { $ifNull: ['$riderEarning', 0] },
            ],
          },
          companyCommissionEff: { $ifNull: ['$tx.companyCommission', 0] },
          hasCompanyCommission: {
            $gt: [{ $ifNull: ['$tx.companyCommission', 0] }, 0],
          },
          settlementStatusEff: {
            $toUpper: { $ifNull: ['$tx.settlementStatus', 'UNPAID'] },
          },
          shipperName: {
            $ifNull: ['$shipperDoc.companyName', '$shipperDoc.name'],
          },
        },
      },
      {
        $addFields: {
          riderPayoutPaidComponent: {
            $cond: [
              {
                $and: [
                  { $gt: ['$riderPaid', 0] },
                  {
                    $in: [
                      '$settlementStatusEff',
                      ['PAID', 'SETTLED'],
                    ],
                  },
                ],
              },
              '$riderPaid',
              0,
            ],
          },
          riderPayoutUnpaidComponent: {
            $cond: [
              {
                $and: [
                  { $gt: ['$riderPaid', 0] },
                  {
                    $in: [
                      '$settlementStatusEff',
                      ['UNPAID', 'PENDING'],
                    ],
                  },
                ],
              },
              '$riderPaid',
              0,
            ],
          },
          companyProfitPerOrder: {
            $cond: [
              '$hasCompanyCommission',
              { $subtract: ['$companyCommissionEff', '$riderPaid'] },
              { $subtract: ['$serviceChargesEff', '$riderPaid'] },
            ],
          },
        },
      },
      {
        $sort: {
          effectiveDate: -1,
          'shipperName': 1,
        },
      },
      {
        $project: {
          bookingId: 1,
          trackingId: 1,
          shipper: 1,
          shipperName: 1,
          effectiveDate: 1,
          effectiveStatus: 1,
          codEffective: 1,
          serviceChargesEff: 1,
          riderPayoutPaidComponent: 1,
          riderPayoutUnpaidComponent: 1,
          companyProfitPerOrder: 1,
        },
      },
    );

    const docs = await Order.aggregate(pipeline);

    const rows = docs.map((doc) => ({
      id: String(doc._id),
      date: doc.effectiveDate || doc.createdAt,
      shipperId: doc.shipper,
      shipperName: doc.shipperName,
      bookingId: doc.bookingId,
      trackingId: doc.trackingId,
      cod: Number(doc.codEffective || 0),
      serviceCharges: Number(doc.serviceChargesEff || 0),
      riderPayout: Number(doc.riderPayoutPaidComponent || 0),
      riderPayoutUnpaid: Number(doc.riderPayoutUnpaidComponent || 0),
      companyProfit: Number(doc.companyProfitPerOrder || 0),
      status: doc.effectiveStatus,
    }));

    const totals = rows.reduce(
      (acc, row) => {
        acc.totalCod += row.cod;
        acc.totalServiceCharges += row.serviceCharges;
        acc.totalRiderPayoutPaid += row.riderPayout;
        acc.totalRiderPayoutUnpaid += row.riderPayoutUnpaid;
        acc.totalCompanyProfit += row.companyProfit;
        acc.totalOrders += 1;
        return acc;
      },
      {
        totalCod: 0,
        totalServiceCharges: 0,
        totalRiderPayoutPaid: 0,
        totalRiderPayoutUnpaid: 0,
        totalCompanyProfit: 0,
        totalOrders: 0,
      },
    );

    totals.totalRiderPayout =
      totals.totalRiderPayoutPaid + totals.totalRiderPayoutUnpaid;

    res.json({
      rows,
      totals,
      activePeriod,
    });
  } catch (error) {
    next(error);
  }
};

// POST /api/finance/company/close-month - CEO/MANAGER only
exports.closeCurrentFinanceMonth = async (req, res, next) => {
  try {
    const userId = req.user && (req.user.id || req.user._id);

    let active = await FinancePeriod.findOne({ status: 'OPEN' }).sort({ periodStart: -1 });
    if (!active) {
      active = await getOrCreateActiveFinancePeriod(userId);
    }

    const periodStart = new Date(active.periodStart);
    const periodEnd = new Date(periodStart);
    // Set periodEnd to last day of the month at 23:59:59.999
    periodEnd.setMonth(periodEnd.getMonth() + 1, 0);
    periodEnd.setHours(23, 59, 59, 999);

    active.status = 'CLOSED';
    active.periodEnd = periodEnd;
    active.closedAt = new Date();
    if (userId) active.closedBy = userId;
    await active.save();

    // Start a new active period from the beginning of the next day
    const nextStart = new Date(periodEnd.getTime() + 1);
    nextStart.setHours(0, 0, 0, 0);

    const newActive = await FinancePeriod.create({
      periodStart: nextStart,
      status: 'OPEN',
    });

    res.json({
      success: true,
      closedPeriodId: active._id,
      newActivePeriodId: newActive._id,
      activePeriod: newActive,
    });
  } catch (error) {
    next(error);
  }
};
