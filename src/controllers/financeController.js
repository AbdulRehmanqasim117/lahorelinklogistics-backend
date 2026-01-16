const prisma = require('../prismaClient');

async function getOrCreateActiveFinancePeriod(userId) {
  let period = await prisma.financePeriod.findFirst({
    where: { status: 'OPEN' },
    orderBy: { periodStart: 'desc' },
  });

  if (period) {
    return period;
  }

  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);

  period = await prisma.financePeriod.create({
    data: {
      periodStart: start,
      status: 'OPEN',
    },
  });

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

  const shipperFilter = shipperId || shipper;
  const riderFilter = riderId || rider;

  const dateRange = buildDateRangeFromQuery(range, from, to);

  return {
    range,
    from,
    to,
    shipperId: shipperFilter || null,
    riderId: riderFilter || null,
    dateRange,
  };
}
// Prisma-based equivalent for order filters used in company finance
function buildPrismaOrderWhere(filters) {
  const where = {
    isDeleted: false,
    status: { in: ['DELIVERED', 'RETURNED', 'FAILED'] },
  };

  if (filters.shipperId) {
    const sid = Number(filters.shipperId);
    if (Number.isInteger(sid) && sid > 0) {
      where.shipperId = sid;
    }
  }

  if (filters.riderId) {
    const rid = Number(filters.riderId);
    if (Number.isInteger(rid) && rid > 0) {
      where.assignedRiderId = rid;
    }
  }

  if (filters.dateRange && (filters.dateRange.start || filters.dateRange.end)) {
    const createdAt = {};
    if (filters.dateRange.start) createdAt.gte = filters.dateRange.start;
    if (filters.dateRange.end) createdAt.lte = filters.dateRange.end;
    where.createdAt = createdAt;
  }

  return where;
}

exports.getShipperSummary = async (req, res, next) => {
  try {
    const activePeriod = await getOrCreateActiveFinancePeriod(
      req.user && req.user.id,
    );

    const where = {};
    if (activePeriod && activePeriod.periodStart) {
      const end = activePeriod.periodEnd || new Date();
      where.createdAt = {
        gte: activePeriod.periodStart,
        lte: end,
      };
    }

    const transactions = await prisma.financialTransaction.findMany({
      where,
      include: {
        shipper: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
      },
    });

    const byShipper = new Map();

    for (const tx of transactions) {
      const shipperId = tx.shipperId;
      if (!shipperId) continue;

      let row = byShipper.get(shipperId);
      if (!row) {
        row = {
          _id: shipperId,
          shipperName: tx.shipper?.name || "",
          shipperEmail: tx.shipper?.email || "",
          totalCodCollected: 0,
          totalShipperShare: 0,
          totalCompanyCommission: 0,
          ordersCount: 0,
        };
        byShipper.set(shipperId, row);
      }

      row.totalCodCollected += Number(tx.totalCodCollected || 0);
      row.totalShipperShare += Number(tx.shipperShare || 0);
      row.totalCompanyCommission += Number(tx.companyCommission || 0);
      row.ordersCount += 1;
    }

    res.json(Array.from(byShipper.values()));
  } catch (error) {
    next(error);
  }
};

exports.getTransactionByOrder = async (req, res, next) => {
  try {
    const rawOrderId = req.params && req.params.orderId;
    const orderId = Number(rawOrderId);

    if (!Number.isInteger(orderId) || orderId <= 0) {
      return res.status(400).json({ message: 'Invalid order id' });
    }

    const tx = await prisma.financialTransaction.findUnique({
      where: { orderId },
    });

    if (!tx) {
      return res.status(404).json({ message: 'Transaction not found' });
    }

    const role = req.user && req.user.role;
    const rawUserId = req.user && (req.user.id || req.user._id);
    const userId = Number(rawUserId);

    if (
      role === 'SHIPPER' &&
      Number.isInteger(userId) &&
      userId > 0 &&
      tx.shipperId !== userId
    ) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    if (
      role === 'RIDER' &&
      Number.isInteger(userId) &&
      userId > 0 &&
      tx.riderId !== userId
    ) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    res.json(tx);
  } catch (error) {
    next(error);
  }
};

exports.getRiderSummary = async (req, res, next) => {
  try {
    const activePeriod = await getOrCreateActiveFinancePeriod(
      req.user && req.user.id,
    );

    const where = {};
    if (activePeriod && activePeriod.periodStart) {
      const end = activePeriod.periodEnd || new Date();
      where.createdAt = {
        gte: activePeriod.periodStart,
        lte: end,
      };
    }

    const transactions = await prisma.financialTransaction.findMany({
      where,
      include: {
        rider: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    });

    const byRider = new Map();

    for (const tx of transactions) {
      const riderId = tx.riderId || 0;

      let row = byRider.get(riderId);
      if (!row) {
        row = {
          _id: riderId || null,
          riderName: tx.rider?.name || 'Unassigned',
          totalCodCollected: 0,
          deliveredCount: 0,
          pendingSettlements: 0,
          settledTransactions: 0,
        };
        byRider.set(riderId, row);
      }

      row.totalCodCollected += Number(tx.totalCodCollected || 0);
      row.deliveredCount += 1;

      const st = String(tx.settlementStatus || '').toUpperCase();
      if (['UNPAID', 'PENDING'].includes(st)) {
        row.pendingSettlements += 1;
      }
      if (['PAID', 'SETTLED'].includes(st)) {
        row.settledTransactions += 1;
      }
    }

    res.json(Array.from(byRider.values()));
  } catch (error) {
    next(error);
  }
};

exports.settleTransaction = async (req, res, next) => {
  try {
    const { id } = req.params;

    const transaction = await prisma.financialTransaction.update({
      where: { id },
      data: { settlementStatus: 'SETTLED' },
    });

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
    const rawId = req.user && (req.user.id || req.user._id);
    const riderId = Number(rawId);

    if (!Number.isInteger(riderId) || riderId <= 0) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const todayStr = new Date().toDateString();

    const transactions = await prisma.financialTransaction.findMany({
      where: { riderId },
      orderBy: { createdAt: 'desc' },
    });

    const totals = transactions.reduce(
      (acc, t) => {
        const cod = Number(t.totalCodCollected || 0);
        acc.totalCodCollected += cod;

        const createdDate = t.createdAt
          ? new Date(t.createdAt).toDateString()
          : null;
        if (createdDate === todayStr) {
          acc.todayCodCollected += cod;
        }

        const st = String(t.settlementStatus || '').toUpperCase();
        if (['UNPAID', 'PENDING'].includes(st)) acc.pendingCount += 1;
        if (['PAID', 'SETTLED'].includes(st)) acc.settledCount += 1;

        return acc;
      },
      {
        totalCodCollected: 0,
        todayCodCollected: 0,
        pendingCount: 0,
        settledCount: 0,
      },
    );

    const mapped = transactions.map((t) => ({
      ...t,
      _id: t.id,
    }));

    res.json({ totals, transactions: mapped });
  } catch (error) {
    next(error);
  }
};

exports.getMyShipperSummary = async (req, res, next) => {
  try {
    console.log('DEBUG getMyShipperSummary req.user:', req.user);
    const rawId = req.user && (req.user.id || req.user._id);
    const shipperId = Number(rawId);
    console.log('DEBUG getMyShipperSummary shipperId:', shipperId);

    if (!Number.isInteger(shipperId) || shipperId <= 0) {
      console.log('DEBUG getMyShipperSummary NO SHIPPER ID!');
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const transactions = await prisma.financialTransaction.findMany({
      where: { shipperId },
      orderBy: { createdAt: 'desc' },
    });
    console.log(
      'DEBUG getMyShipperSummary found transactions:',
      transactions.length,
    );

    const totals = transactions.reduce(
      (acc, t) => {
        acc.totalCodCollected += Number(t.totalCodCollected || 0);
        acc.totalCompanyCommission += Number(t.companyCommission || 0);
        acc.totalShipperShare += Number(t.shipperShare || 0);
        return acc;
      },
      {
        totalCodCollected: 0,
        totalCompanyCommission: 0,
        totalShipperShare: 0,
      },
    );

    console.log('DEBUG getMyShipperSummary response:', {
      totals,
      transactionCount: transactions.length,
    });

    const mapped = transactions.map((t) => ({
      ...t,
      _id: t.id,
    }));

    res.json({ totals, transactions: mapped });
  } catch (error) {
    console.error('DEBUG getMyShipperSummary error:', error.message, error.stack);
    next(error);
  }
};

exports.setRiderSettlementByOrder = async (req, res, next) => {
  try {
    const rawOrderId = req.params && req.params.id;
    const orderId = Number(rawOrderId);
    if (!Number.isInteger(orderId) || orderId <= 0) {
      return res.status(400).json({ message: 'Invalid order id' });
    }

    const tx = await prisma.financialTransaction.findUnique({
      where: { orderId },
    });

    if (!tx) {
      return res
        .status(404)
        .json({ message: 'Transaction not found for this order' });
    }

    const rawStatus =
      (req.body && (req.body.status || req.body.settlementStatus)) || '';
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

    const updateData = {
      settlementStatus,
      paidAt: null,
      paidById: null,
    };

    if (settlementStatus === 'PAID' || settlementStatus === 'SETTLED') {
      const rawUserId = req.user && (req.user.id || req.user._id);
      const paidById = Number(rawUserId);
      if (Number.isInteger(paidById) && paidById > 0) {
        updateData.paidAt = new Date();
        updateData.paidById = paidById;
      }
    }

    const updated = await prisma.financialTransaction.update({
      where: { id: tx.id },
      data: updateData,
    });

    res.json(updated);
  } catch (error) {
    next(error);
  }
};

// Company finance summary for CEO/Manager (Prisma-based)
// GET /api/finance/company/summary
exports.getCompanyFinanceSummary = async (req, res, next) => {
  try {
    const filters = buildOrderFiltersFromQuery(req.query);
    const where = buildPrismaOrderWhere(filters);

    // By default, when no explicit date range is provided, we scope the
    // summary to the currently active finance period. This ensures that
    // after closing a month, metrics reset for the new period instead of
    // always showing all-time totals.
    const activePeriod = await getOrCreateActiveFinancePeriod(
      req.user && req.user.id,
    );

    const hasExplicitRange =
      filters.dateRange && (filters.dateRange.start || filters.dateRange.end);

    console.log('DEBUG getCompanyFinanceSummary filters:', filters);
    console.log('DEBUG getCompanyFinanceSummary activePeriod:', activePeriod);
    console.log('DEBUG getCompanyFinanceSummary initial where:', where);

    if (!hasExplicitRange && activePeriod && activePeriod.periodStart) {
      const end = activePeriod.periodEnd || new Date();
      where.createdAt = {
        gte: activePeriod.periodStart,
        lte: end,
      };
      console.log(
        'DEBUG getCompanyFinanceSummary applying activePeriod window:',
        where.createdAt,
      );
    }

    const orders = await prisma.order.findMany({
      where,
      include: {
        financialTransaction: true,
      },
    });

    let ordersCount = 0;
    let totalCod = 0;
    let totalServiceCharges = 0;
    let deliveredOrders = 0;
    let returnedOrders = 0;
    let pendingRiderSettlementsCount = 0;
    let pendingRiderSettlementsAmount = 0;
    let settledRiderTransactionsCount = 0;
    let totalRiderPaid = 0;
    let totalCompanyCommission = 0;

    for (const o of orders) {
      const tx = o.financialTransaction;
      const effectiveStatus = String(o.status || '').toUpperCase();
      ordersCount += 1;

      const codEffective =
        o.paymentType === 'COD' && effectiveStatus === 'DELIVERED'
          ? Number(o.amountCollected ?? o.codAmount ?? 0)
          : 0;
      const serviceChargesEff = Number(o.serviceCharges || 0);
      const riderPaid = tx && tx.riderCommission ? Number(tx.riderCommission) : 0;
      const companyCommissionEff = tx && tx.companyCommission ? Number(tx.companyCommission) : 0;
      const settlementStatusEff = String(tx?.settlementStatus || 'UNPAID').toUpperCase();

      totalCod += codEffective;
      totalServiceCharges += serviceChargesEff;
      totalRiderPaid += riderPaid;
      totalCompanyCommission += companyCommissionEff;

      if (effectiveStatus === 'DELIVERED') deliveredOrders += 1;
      if (effectiveStatus === 'RETURNED') returnedOrders += 1;

      if (['UNPAID', 'PENDING'].includes(settlementStatusEff) && riderPaid > 0) {
        pendingRiderSettlementsCount += 1;
        pendingRiderSettlementsAmount += riderPaid;
      }
      if (['PAID', 'SETTLED'].includes(settlementStatusEff) && riderPaid > 0) {
        settledRiderTransactionsCount += 1;
      }
    }

    const codCollected = totalCod;
    const serviceChargesTotal = totalServiceCharges;
    const riderPayoutTotal = totalRiderPaid;
    const netProfit = serviceChargesTotal - riderPayoutTotal;

    // Backwards-compatible fields used by existing dashboards
    const totalAmount = codCollected + serviceChargesTotal;
    const companyProfit = netProfit;
    const unpaidRiderBalances = pendingRiderSettlementsAmount;

    res.json({
      filters: {
        range: filters.range,
        from: filters.from || null,
        to: filters.to || null,
        shipperId: filters.shipperId,
        riderId: filters.riderId,
      },
      metrics: {
        ordersCount,
        // Legacy-style totals kept for compatibility
        totalCod: codCollected,
        totalServiceCharges: serviceChargesTotal,
        totalAmount,
        deliveredOrders,
        returnedOrders,
        pendingRiderSettlementsCount,
        pendingRiderSettlementsAmount,
        settledRiderTransactionsCount,
        unpaidRiderBalances,
        totalRiderPaid: riderPayoutTotal,
        totalCompanyCommission,
        companyProfit,
        // New explicit metrics for CEO finance dashboard
        codCollected,
        serviceChargesTotal,
        riderPayoutTotal,
        netProfit,
      },
      // Debug info to inspect active finance window without relying on server logs
      debug: {
        rawFilters: filters,
        activePeriod,
        whereCreatedAt: where.createdAt || null,
      },
    });
  } catch (error) {
    next(error);
  }
};

// Company-wide ledger for CEO/Manager (Prisma-based)
// GET /api/finance/company/ledger
exports.getCompanyLedger = async (req, res, next) => {
  try {
    const filters = buildOrderFiltersFromQuery(req.query);
    const where = buildPrismaOrderWhere(filters);

    const activePeriod = await getOrCreateActiveFinancePeriod(
      req.user && req.user.id,
    );

    // Similar to the summary endpoint, when no explicit date range is
    // provided we default the ledger view to the active finance
    // period's start/end dates.
    const hasExplicitRange =
      filters.dateRange && (filters.dateRange.start || filters.dateRange.end);

    console.log('DEBUG getCompanyLedger filters:', filters);
    console.log('DEBUG getCompanyLedger activePeriod:', activePeriod);
    console.log('DEBUG getCompanyLedger initial where:', where);

    if (!hasExplicitRange && activePeriod && activePeriod.periodStart) {
      const end = activePeriod.periodEnd || new Date();
      where.createdAt = {
        gte: activePeriod.periodStart,
        lte: end,
      };
      console.log(
        'DEBUG getCompanyLedger applying activePeriod window:',
        where.createdAt,
      );
    }

    const orders = await prisma.order.findMany({
      where,
      include: {
        shipper: { select: { id: true, name: true, companyName: true } },
        financialTransaction: true,
      },
      orderBy: [
        { deliveredAt: 'desc' },
        { createdAt: 'desc' },
      ],
    });

    const rows = orders.map((o) => {
      const tx = o.financialTransaction;
      const effectiveStatus = String(o.status || '').toUpperCase();
      const effectiveDate = o.deliveredAt || o.createdAt;

      const codEffective =
        o.paymentType === 'COD' && effectiveStatus === 'DELIVERED'
          ? Number(o.amountCollected ?? o.codAmount ?? 0)
          : 0;
      const serviceChargesEff = Number(o.serviceCharges || 0);
      const riderPaid = tx && tx.riderCommission ? Number(tx.riderCommission) : 0;
      const companyCommissionEff = tx && tx.companyCommission ? Number(tx.companyCommission) : 0;
      const settlementStatusEff = String(tx?.settlementStatus || 'UNPAID').toUpperCase();

      const riderPayoutPaidComponent =
        riderPaid > 0 && ['PAID', 'SETTLED'].includes(settlementStatusEff)
          ? riderPaid
          : 0;
      const riderPayoutUnpaidComponent =
        riderPaid > 0 && ['UNPAID', 'PENDING'].includes(settlementStatusEff)
          ? riderPaid
          : 0;
      // For per-order view and summary cards we want to show the full
      // rider commission as "Rider Payout", regardless of whether it
      // has been settled yet. Paid vs unpaid is still tracked in the full
      // totals via riderPayoutPaidComponent / riderPayoutUnpaidComponent.
      const companyProfitPerOrder = serviceChargesEff - riderPaid;

      const shipperName = o.shipper?.companyName || o.shipper?.name || '';

      return {
        id: o.id.toString(),
        date: effectiveDate,
        shipperId: o.shipperId,
        shipperName,
        bookingId: o.bookingId,
        trackingId: o.trackingId,
        cod: codEffective,
        serviceCharges: serviceChargesEff,
        // Full rider commission for this order
        riderPayout: riderPaid,
        // Paid/unpaid components are used only for aggregated totals
        riderPayoutPaid: riderPayoutPaidComponent,
        riderPayoutUnpaid: riderPayoutUnpaidComponent,
        companyProfit: companyProfitPerOrder,
        status: effectiveStatus,
      };
    });

    const totals = rows.reduce(
      (acc, row) => {
        acc.totalCod += row.cod;
        acc.totalServiceCharges += row.serviceCharges;
        // Use the explicit paid/unpaid components for accurate
        // aggregation, while the visible Rider Payout column shows the
        // full rider commission per order.
        acc.totalRiderPayoutPaid += row.riderPayoutPaid || 0;
        acc.totalRiderPayoutUnpaid += row.riderPayoutUnpaid || 0;
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
    // Alias for clarity in frontend: COD is shipper funds, not revenue.
    totals.codCollected = totals.totalCod;

    res.json({
      rows,
      totals,
      activePeriod,
      // Debug info so frontend can inspect date filters / period without
      // needing access to server console logs
      debug: {
        rawFilters: filters,
        whereCreatedAt: where.createdAt || null,
      },
    });
  } catch (error) {
    next(error);
  }
};

// POST /api/finance/company/close-month - CEO/MANAGER only
exports.closeCurrentFinanceMonth = async (req, res, next) => {
  try {
    const rawUserId = req.user && (req.user.id || req.user._id);
    const numericUserId = Number(rawUserId);
    const closedById =
      Number.isInteger(numericUserId) && numericUserId > 0 ? numericUserId : null;

    let active = await prisma.financePeriod.findFirst({
      where: { status: 'OPEN' },
      orderBy: { periodStart: 'desc' },
    });

    if (!active) {
      active = await getOrCreateActiveFinancePeriod(closedById);
    }

    // Close the current period up to "today" rather than strictly
    // calendar month boundaries. This makes the behaviour of the
    // "Close Current Month" button intuitive for the CEO: after
    // closing, all existing finance activity is locked into the
    // closed period and the new active period starts fresh from the
    // next day (showing zeros until new orders are delivered).

    const now = new Date();
    const periodStart = new Date(active.periodStart);
    const periodEnd = new Date(now);
    // Normalize to end-of-day for the close timestamp
    periodEnd.setHours(23, 59, 59, 999);

    const closed = await prisma.financePeriod.update({
      where: { id: active.id },
      data: {
        status: 'CLOSED',
        periodEnd,
        closedAt: new Date(),
        closedById,
      },
    });

    // New active period starts from the next calendar day at
    // midnight, so it will not include any of the orders that were
    // part of the closed period.
    const nextStart = new Date(periodEnd.getTime() + 1);
    nextStart.setHours(0, 0, 0, 0);

    const newActive = await prisma.financePeriod.create({
      data: {
        periodStart: nextStart,
        status: 'OPEN',
      },
    });

    res.json({
      success: true,
      closedPeriodId: closed.id,
      newActivePeriodId: newActive.id,
      activePeriod: newActive,
    });
  } catch (error) {
    next(error);
  }
};
