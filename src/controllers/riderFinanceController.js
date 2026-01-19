const prisma = require('../prismaClient');

// GET /api/riders/finance/me
// Rider self-finance view (only their own assigned orders)
exports.getMyFinance = async (req, res, next) => {
  try {
    const riderId = Number(req.user.id);
    if (!riderId || !Number.isInteger(riderId)) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const {
      from,
      to,
      status = 'all',
      sortOrder = 'desc',
      page = 1,
      limit = 20,
    } = req.query;

    const allowedFinalStatuses = ['DELIVERED', 'RETURNED', 'FAILED'];
    const normalizedStatus = String(status || 'all').toLowerCase();

    let statusFilter;
    if (normalizedStatus === 'delivered') {
      statusFilter = 'DELIVERED';
    } else if (normalizedStatus === 'returned') {
      statusFilter = 'RETURNED';
    } else if (normalizedStatus === 'failed') {
      statusFilter = 'FAILED';
    } else {
      statusFilter = { in: allowedFinalStatuses };
    }

    const where = {
      assignedRiderId: riderId,
      isDeleted: false,
      status: statusFilter,
    };

    if (from || to) {
      const createdAt = {};
      if (from) {
        const d = new Date(from);
        d.setHours(0, 0, 0, 0);
        if (!Number.isNaN(d.getTime())) createdAt.gte = d;
      }
      if (to) {
        const d = new Date(to);
        d.setHours(23, 59, 59, 999);
        if (!Number.isNaN(d.getTime())) createdAt.lte = d;
      }
      if (Object.keys(createdAt).length) {
        where.createdAt = createdAt;
      }
    }

    const pageNum = Math.max(1, Number(page) || 1);
    const limitNum = Math.min(100, Math.max(1, Number(limit) || 20));
    const orderDir = sortOrder === 'asc' ? 'asc' : 'desc';

    const [unpaidBalanceRow, total, orders] = await Promise.all([
      prisma.financialTransaction.aggregate({
        _sum: { riderCommission: true },
        where: {
          riderId,
          settlementStatus: { in: ['UNPAID', 'PENDING'] },
        },
      }),
      prisma.order.count({ where }),
      prisma.order.findMany({
        where,
        include: {
          shipper: { select: { companyName: true, name: true } },
          financialTransaction: true,
        },
        orderBy: { createdAt: orderDir },
        skip: (pageNum - 1) * limitNum,
        take: limitNum,
      }),
    ]);

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
      const tx = o.financialTransaction;

      const isDelivered = o.status === 'DELIVERED';
      const isCod = o.paymentType === 'COD';

      let codAmount = 0;
      if (isDelivered && isCod) {
        codAmount = Number(o.amountCollected ?? o.codAmount ?? 0);
      } else {
        codAmount = 0;
      }

      let riderEarning = Number(
        o.riderEarning !== undefined && o.riderEarning !== null
          ? o.riderEarning
          : tx?.riderCommission || 0,
      );

      if (!Number.isFinite(riderEarning) || riderEarning < 0) {
        riderEarning = 0;
      }

      const normalizedTxStatus = String(tx?.settlementStatus || '').toUpperCase();
      const settlementStatus =
        normalizedTxStatus === 'PAID' || normalizedTxStatus === 'SETTLED'
          ? 'PAID'
          : 'UNPAID';

      if (o.status === 'DELIVERED') {
        summary.deliveredCount += 1;
      } else if (o.status === 'RETURNED') {
        summary.returnedCount += 1;
      } else if (o.status === 'FAILED') {
        summary.failedCount += 1;
      }

      if (isDelivered && isCod && codAmount > 0) {
        summary.codCollected += codAmount;
      }

      summary.serviceChargesTotal += Number(o.serviceCharges || 0);
      summary.riderEarnings += riderEarning;
      if (settlementStatus === 'PAID') {
        summary.riderEarningsPaid += riderEarning;
      } else {
        summary.riderEarningsUnpaid += riderEarning;
      }

      const externalOrderNo =
        o.sourceProviderOrderNumber || o.externalOrderId || o.bookingId;

      return {
        id: o.id,
        // For integrated orders, surface Shopify/external order number
        // instead of internal bookingId wherever we show "Order ID".
        orderId: externalOrderNo,
        date: o.deliveredAt || o.updatedAt || o.createdAt,
        shipperName: o.shipper?.companyName || o.shipper?.name || '',
        destination: o.destinationCity || '',
        codAmount,
        serviceCharges: Number(o.serviceCharges || 0),
        riderEarning,
        status: o.status,
        settlementStatus,
        riderSettlementAt: tx?.paidAt || null,
        riderSettlementBy: tx?.paidById || null,
      };
    });

    summary.unpaidBalance = Number(
      unpaidBalanceRow?._sum?.riderCommission || summary.riderEarningsUnpaid,
    );

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
      page: 1,
      limit: total,
      total,
      totalPages: 1,
    });
  } catch (error) {
    next(error);
  }
};

// GET /api/riders/:id/settlements
// Admin (CEO/MANAGER) view of a specific rider's settlements with filters.
exports.getRiderSettlementsAdmin = async (req, res, next) => {
  try {
    const riderId = Number(req.params.id);
    if (!Number.isInteger(riderId) || riderId <= 0) {
      return res.status(400).json({ message: 'Invalid rider id' });
    }

    const {
      from,
      to,
      status = 'all',
      settlement = 'all',
      sortOrder = 'desc',
      // page/limit are no longer used since admin rider settlements now
      // return all matching orders in a single response without
      // pagination. We still accept them in the query for
      // backwards-compatibility but ignore their values.
      page,
      limit,
      shipperId,
      search,
    } = req.query;

    const allowedFinalStatuses = ['DELIVERED', 'RETURNED', 'FAILED'];
    const normalizedStatus = String(status || 'all').toLowerCase();

    let statusFilter;
    if (normalizedStatus === 'delivered') {
      statusFilter = 'DELIVERED';
    } else if (normalizedStatus === 'returned') {
      statusFilter = 'RETURNED';
    } else if (normalizedStatus === 'failed') {
      statusFilter = 'FAILED';
    } else {
      statusFilter = { in: allowedFinalStatuses };
    }

    const where = {
      assignedRiderId: riderId,
      isDeleted: false,
      status: statusFilter,
    };

    if (from || to) {
      const createdAt = {};
      if (from) {
        const d = new Date(from);
        d.setHours(0, 0, 0, 0);
        if (!Number.isNaN(d.getTime())) createdAt.gte = d;
      }
      if (to) {
        const d = new Date(to);
        d.setHours(23, 59, 59, 999);
        if (!Number.isNaN(d.getTime())) createdAt.lte = d;
      }
      if (Object.keys(createdAt).length) {
        where.createdAt = createdAt;
      }
    }

    if (shipperId) {
      const sid = Number(shipperId);
      if (Number.isInteger(sid) && sid > 0) {
        where.shipperId = sid;
      }
    }

    if (search && String(search).trim()) {
      const q = String(search).trim();
      // Allow admin rider settlements search by booking, tracking, or
      // external provider order number (e.g. Shopify order number).
      where.OR = [
        { bookingId: { contains: q, mode: 'insensitive' } },
        { trackingId: { contains: q, mode: 'insensitive' } },
        { sourceProviderOrderNumber: { contains: q, mode: 'insensitive' } },
      ];
    }

    const orderDir = sortOrder === 'asc' ? 'asc' : 'desc';

    const [total, orders] = await Promise.all([
      prisma.order.count({ where }),
      prisma.order.findMany({
        where,
        include: {
          shipper: { select: { companyName: true, name: true } },
          financialTransaction: true,
        },
        orderBy: { createdAt: orderDir },
      }),
    ]);

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
      const tx = o.financialTransaction;

      let riderEarning = Number(tx?.riderCommission || 0);
      if (!Number.isFinite(riderEarning) || riderEarning < 0) {
        riderEarning = 0;
      }

      const normalizedTxStatus = String(tx?.settlementStatus || '').toUpperCase();
      const settlementStatus =
        normalizedTxStatus === 'PAID' || normalizedTxStatus === 'SETTLED'
          ? 'PAID'
          : 'UNPAID';

      const date = o.deliveredAt || o.updatedAt || o.createdAt;
      const codAmount =
        o.status === 'DELIVERED'
          ? Number(o.amountCollected ?? o.codAmount ?? 0)
          : Number(o.codAmount ?? 0);

      const weightKg = Number(o.weightKg || 0);
      const min =
        typeof o.serviceChargesBracketMin === 'number' &&
        Number.isFinite(o.serviceChargesBracketMin)
          ? o.serviceChargesBracketMin
          : null;
      const max =
        typeof o.serviceChargesBracketMax === 'number' &&
        Number.isFinite(o.serviceChargesBracketMax)
          ? o.serviceChargesBracketMax
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

      const externalOrderNo =
        o.sourceProviderOrderNumber || o.externalOrderId || o.bookingId;

      return {
        id: o.id,
        // Show Shopify/external order number for integrated orders in
        // all rider settlement views.
        orderId: externalOrderNo,
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
        riderSettlementAt: tx?.paidAt || null,
        riderSettlementBy: tx?.paidById || null,
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
      // Admin view now returns all rows in a single page (no pagination).
      page: 1,
      limit: total,
      total,
      totalPages: 1,
    });
  } catch (error) {
    next(error);
  }
};
