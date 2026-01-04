const prisma = require('../prismaClient');

const formatPolicy = (cfg) => {
  if (!cfg) return null;
  const brackets = Array.isArray(cfg.weightBrackets) ? cfg.weightBrackets : [];
  return {
    type: cfg.type,
    value: cfg.value,
    weightBrackets: brackets
      .slice()
      .sort((a, b) => Number(a.minKg || 0) - Number(b.minKg || 0))
      .map((b) => ({
        minKg: b.minKg,
        maxKg: b.maxKg === undefined ? null : b.maxKg,
        // Prisma uses chargePkr; legacy Mongoose used charge
        charge: b.chargePkr !== undefined ? b.chargePkr : b.charge,
      })),
  };
};

exports.getMyFinanceSummary = async (req, res, next) => {
  try {
    const shipperIdRaw = req.user.id || req.user._id;
    const shipperId = Number(shipperIdRaw);

    if (!Number.isInteger(shipperId) || shipperId <= 0) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const [user, profile, cfg, orders] = await Promise.all([
      prisma.user.findUnique({ where: { id: shipperId } }),
      prisma.shipperProfile.findUnique({ where: { userId: shipperId } }),
      prisma.commissionConfig.findUnique({
        where: { shipperId },
        include: { weightBrackets: true },
      }),
      prisma.order.findMany({
        where: {
          shipperId,
          isDeleted: false,
          status: { in: ['DELIVERED', 'RETURNED'] },
        },
        select: {
          status: true,
          paymentType: true,
          amountCollected: true,
          codAmount: true,
          serviceCharges: true,
        },
      }),
    ]);

    let balance = 0;
    for (const o of orders) {
      const isDelivered = o.status === 'DELIVERED';
      const cod =
        isDelivered && o.paymentType === 'COD'
          ? Number(o.amountCollected ?? o.codAmount ?? 0)
          : 0;
      const svc = Number(o.serviceCharges || 0);
      const receivable = cod - svc;
      balance += receivable;
    }

    const shipper = user
      ? {
          _id: user.id,
          id: user.id,
          name: user.name,
          companyName: user.companyName || profile?.companyName || null,
          phone: user.phone || user.contactNumber || null,
          email: user.email,
          address: user.pickupAddress || profile?.address || null,
          cnic: user.cnic || user.cnicNumber || null,
          iban: user.iban || null,
          bankName: user.bankName || null,
          accountType: user.accountType || null,
          accountNumber: user.accountNumber || null,
          accountHolderName: user.accountHolderName || null,
          createdAt: user.createdAt,
        }
      : null;

    res.json({
      shipper,
      serviceChargesPolicy: formatPolicy(cfg),
      balance: Number(balance || 0),
    });
  } catch (error) {
    next(error);
  }
};

exports.getMyFinanceLedger = async (req, res, next) => {
  try {
    const shipperIdRaw = req.user.id || req.user._id;
    const shipperId = Number(shipperIdRaw);

    if (!Number.isInteger(shipperId) || shipperId <= 0) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const {
      from,
      to,
      status,
      search,
      format,
      page = 1,
      limit = 20,
    } = req.query;

    const where = {
      shipperId,
      isDeleted: false,
    };

    if (from || to) {
      const createdAt = {};
      if (from) {
        const d = new Date(from);
        if (!Number.isNaN(d.getTime())) createdAt.gte = d;
      }
      if (to) {
        const t = new Date(to);
        t.setHours(23, 59, 59, 999);
        if (!Number.isNaN(t.getTime())) createdAt.lte = t;
      }
      if (Object.keys(createdAt).length) {
        where.createdAt = createdAt;
      }
    }

    if (search && String(search).trim()) {
      const term = String(search).trim();
      where.bookingId = { contains: term, mode: 'insensitive' };
    }

    // status filter currently not wired to a dedicated ledger table; keep all
    // rows regardless of PAID/UNPAID toggle for now.

    const pageNum = Math.max(1, Number(page) || 1);
    const isCsv = String(format).toLowerCase() === 'csv';
    const exportAll =
      String(limit).toLowerCase() === 'all' || isCsv;
    const limitNum = exportAll
      ? 5000
      : Math.min(200, Math.max(1, Number(limit) || 20));

    const [total, orders] = await Promise.all([
      prisma.order.count({ where }),
      prisma.order.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: exportAll ? 0 : (pageNum - 1) * limitNum,
        take: exportAll ? limitNum : limitNum,
      }),
    ]);

    const rows = orders.map((o) => {
      const isDelivered = o.status === 'DELIVERED';
      const codForDelivered =
        isDelivered && o.paymentType === 'COD'
          ? Number(o.amountCollected ?? o.codAmount ?? 0)
          : 0;
      const codAmount =
        isDelivered && o.paymentType === 'COD'
          ? codForDelivered
          : Number(o.codAmount ?? 0);

      const serviceCharges = Number(o.serviceCharges || 0);
      const receivable = codAmount - serviceCharges;

      return {
        _id: o.id,
        id: o.id,
        date: o.deliveredAt || o.updatedAt || o.createdAt,
        particular: o.consigneeName || 'Order',
        bookingId: o.bookingId,
        codAmount,
        serviceCharges,
        receivable,
        amount: receivable,
        status: 'UNPAID',
        weightKg: o.weightKg,
      };
    });

    const totals = rows.reduce(
      (acc, r) => {
        acc.totalCod += Number(r.codAmount || 0);
        acc.totalServiceCharges += Number(r.serviceCharges || 0);
        acc.totalReceivable += Number(r.receivable || 0);
        acc.totalAmount += Number(r.amount || 0);
        return acc;
      },
      { totalCod: 0, totalServiceCharges: 0, totalReceivable: 0, totalAmount: 0 },
    );

    if (isCsv) {
      const escape = (v) => {
        if (v === null || v === undefined) return '';
        const s = String(v);
        if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
        return s;
      };

      const header = [
        'Date/Time',
        'Particular',
        'Booking ID',
        'COD Amount',
        'Service Charges',
        'Receivable',
        'Paid',
      ];
      const lines = [header.map(escape).join(',')];
      for (const r of rows) {
        lines.push(
          [
            r.date ? new Date(r.date).toISOString() : '',
            r.particular || '',
            r.bookingId || '',
            Number(r.codAmount ?? 0),
            Number(r.serviceCharges ?? 0),
            Number(r.receivable ?? r.amount ?? 0),
            r.status === 'PAID' ? 'Paid' : 'Unpaid',
          ]
            .map(escape)
            .join(','),
        );
      }

      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        'attachment; filename="shipper-ledger.csv"',
      );
      return res.send(lines.join('\n'));
    }

    const totalPages = exportAll ? 1 : Math.ceil(total / limitNum) || 0;

    res.json({
      rows,
      page: pageNum,
      limit: limitNum,
      total,
      totalPages,
      totals: {
        totalCod: Number(totals.totalCod || 0),
        totalServiceCharges: Number(totals.totalServiceCharges || 0),
        totalReceivable: Number(totals.totalReceivable || 0),
        totalAmount: Number(totals.totalAmount || 0),
      },
    });
  } catch (error) {
    next(error);
  }
};
