const mongoose = require('mongoose');
const Order = require('../models/Order');
const User = require('../models/User');
const CommissionConfig = require('../models/CommissionConfig');
const ShipperProfile = require('../models/ShipperProfile');
const ShipperLedger = require('../models/ShipperLedger');
const { calculateServiceCharges } = require('../utils/serviceChargeCalculator');

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
        charge: b.charge,
      })),
  };
};

const ensureLedgerBackfilled = async (shipperId) => {
  const existingCount = await ShipperLedger.countDocuments({ shipperId });
  if (existingCount > 0) return;

  const visibilityFilter = {
    $or: [
      // Normal/manual orders (including legacy ones without flags)
      { isIntegrated: { $ne: true } },
      // Integrated orders: only booked + approved should ever hit the ledger
      {
        isIntegrated: true,
        bookingState: 'BOOKED',
        $or: [{ shipperApprovalStatus: 'approved' }, { shipperApprovalStatus: { $exists: false } }],
      },
    ],
  };

  const orders = await Order.find({
    shipper: shipperId,
    status: { $in: ['DELIVERED', 'RETURNED'] },
    isDeleted: { $ne: true },
    ...visibilityFilter,
  })
    .select(
      '_id shipper bookingId consigneeName status deliveredAt updatedAt createdAt amountCollected codAmount serviceCharges invoice weightKg',
    )
    .lean();

  if (!orders.length) return;

  const ops = [];
  for (const order of orders) {
    if (!order?.bookingId) continue;

    const isDelivered = order.status === 'DELIVERED';
    const cod = isDelivered ? Number(order.amountCollected ?? order.codAmount ?? 0) : 0;

    let serviceCharges = Number(order.serviceCharges || 0);
    if (!serviceCharges || serviceCharges < 0) {
      const calc = await calculateServiceCharges(order, order.weightKg);
      serviceCharges = Number(calc?.serviceCharges || 0);
    }

    const receivable = Number(cod) - Number(serviceCharges);
    const date =
      (isDelivered ? order.deliveredAt : null) || order.updatedAt || order.createdAt || new Date();

    const payload = {
      shipperId: order.shipper,
      date,
      type: 'ORDER',
      orderId: order._id,
      bookingId: order.bookingId,
      particular: order.consigneeName || 'Order',
      codAmount: cod,
      serviceCharges,
      weightKg: order.weightKg,
      receivable,
      amount: receivable,
      status: 'UNPAID',
      createdBy: 'system',
    };

    ops.push({
      updateOne: {
        filter: { shipperId: order.shipper, type: 'ORDER', bookingId: order.bookingId },
        update: { $set: payload },
        upsert: true,
      },
    });
  }

  const batchSize = 500;
  for (let i = 0; i < ops.length; i += batchSize) {
    try {
      await ShipperLedger.bulkWrite(ops.slice(i, i + batchSize), { ordered: false });
    } catch (e) {
      // Ignore duplicate key errors / partial failures; upserts are idempotent.
    }
  }
};

exports.getMyFinanceSummary = async (req, res, next) => {
  try {
    const shipperIdRaw = req.user.id || req.user._id;
    const shipperId = new mongoose.Types.ObjectId(String(shipperIdRaw));

    await ensureLedgerBackfilled(shipperId);

    const [user, profile, cfg, balanceAgg] = await Promise.all([
      User.findById(shipperId).lean(),
      ShipperProfile.findOne({ user: shipperId }).lean(),
      CommissionConfig.findOne({ shipper: shipperId }).lean(),
      ShipperLedger.aggregate([
        { $match: { shipperId } },
        { $group: { _id: null, balance: { $sum: '$amount' } } },
      ]),
    ]);

    const balance = Number(balanceAgg?.[0]?.balance || 0);

    res.json({
      shipper: {
        _id: user?._id,
        name: user?.name,
        companyName: user?.companyName || profile?.companyName,
        phone: user?.phone || user?.contactNumber,
        email: user?.email,
        address: user?.pickupAddress || profile?.address,
        cnic: user?.cnic || user?.cnicNumber,
        iban: user?.iban,
        bankName: user?.bankName,
        accountNumber: user?.accountNumber,
        accountHolderName: user?.accountHolderName,
        createdAt: user?.createdAt,
      },
      serviceChargesPolicy: formatPolicy(cfg),
      balance,
    });
  } catch (error) {
    next(error);
  }
};

exports.getMyFinanceLedger = async (req, res, next) => {
  try {
    const shipperIdRaw = req.user.id || req.user._id;
    const shipperId = new mongoose.Types.ObjectId(String(shipperIdRaw));

    await ensureLedgerBackfilled(shipperId);
    const {
      from,
      to,
      status,
      search,
      format,
      page = 1,
      limit = 20,
    } = req.query;

    const match = {
      shipperId,
    };

    if (from || to) {
      match.date = {};
      if (from) match.date.$gte = new Date(from);
      if (to) {
        const t = new Date(to);
        t.setHours(23, 59, 59, 999);
        match.date.$lte = t;
      }
    }

    if (status && ['PAID', 'UNPAID'].includes(String(status).toUpperCase())) {
      match.status = String(status).toUpperCase();
    }

    if (search && String(search).trim()) {
      match.bookingId = { $regex: String(search).trim(), $options: 'i' };
    }

    const pageNum = Math.max(1, Number(page) || 1);
    const exportAll = String(limit).toLowerCase() === 'all' || String(format).toLowerCase() === 'csv';
    const limitNum = exportAll ? 5000 : Math.min(200, Math.max(1, Number(limit) || 20));

    const [total, totalsAgg] = await Promise.all([
      ShipperLedger.countDocuments(match),
      ShipperLedger.aggregate([
        { $match: match },
        {
          $group: {
            _id: null,
            totalCod: {
              $sum: {
                $cond: [{ $eq: ['$type', 'ORDER'] }, { $ifNull: ['$codAmount', 0] }, 0],
              },
            },
            totalServiceCharges: {
              $sum: {
                $cond: [{ $eq: ['$type', 'ORDER'] }, { $ifNull: ['$serviceCharges', 0] }, 0],
              },
            },
            totalReceivable: {
              $sum: {
                $cond: [{ $eq: ['$type', 'ORDER'] }, { $ifNull: ['$receivable', 0] }, 0],
              },
            },
            totalAmount: { $sum: '$amount' },
          },
        },
      ]),
    ]);

    const rowsQuery = ShipperLedger.find(match).sort({ date: -1, createdAt: -1 });
    const rows = exportAll
      ? await rowsQuery.limit(Math.min(total || 0, limitNum)).lean()
      : await rowsQuery
          .skip((pageNum - 1) * limitNum)
          .limit(limitNum)
          .lean();

    const orderIds = Array.from(
      new Set(
        rows
          .filter((r) => r && r.type === 'ORDER' && r.orderId)
          .map((r) => String(r.orderId)),
      ),
    );
    if (orderIds.length > 0) {
      const orderDocs = await Order.find({ _id: { $in: orderIds } })
        .select('_id weightKg weightOriginalKg bookingId')
        .lean();
      const orderMap = new Map(
        orderDocs.map((o) => [String(o._id), o]),
      );
      for (const row of rows) {
        if (!row || row.type !== 'ORDER' || !row.orderId) continue;
        if (row.weightKg && Number(row.weightKg) > 0) continue;
        const ord = orderMap.get(String(row.orderId));
        if (!ord) continue;
        const raw =
          typeof ord.weightKg === 'number' && ord.weightKg > 0
            ? ord.weightKg
            : ord.weightOriginalKg;
        if (raw && Number(raw) > 0) {
          row.weightKg = Number(raw);
        }
      }
    }

    if (process.env.NODE_ENV !== 'production') {
      try {
        const sample = rows.slice(0, 5).map((r) => ({
          bookingId: r.bookingId,
          type: r.type,
          weightKg: r.weightKg,
        }));
        console.log('[getMyFinanceLedger] sample weights:', sample);
      } catch (e) {
      }
    }

    if (String(format).toLowerCase() === 'csv') {
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
      res.setHeader('Content-Disposition', 'attachment; filename="shipper-ledger.csv"');
      return res.send(lines.join('\n'));
    }

    res.json({
      rows,
      page: pageNum,
      limit: limitNum,
      total,
      totalPages: Math.ceil(total / limitNum),
      totals: {
        totalCod: Number(totalsAgg?.[0]?.totalCod || 0),
        totalServiceCharges: Number(totalsAgg?.[0]?.totalServiceCharges || 0),
        totalReceivable: Number(totalsAgg?.[0]?.totalReceivable || 0),
        totalAmount: Number(totalsAgg?.[0]?.totalAmount || 0),
      },
    });
  } catch (error) {
    next(error);
  }
};
