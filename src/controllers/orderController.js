const generateBookingId = require('../config/bookingId');
const generateTrackingId = require('../config/trackingId');
const QRCode = require('qrcode');
const prisma = require('../prismaClient');
const { computeServiceChargeKgBased } = require('../utils/serviceChargeCalculator');

// Map Prisma Order + relations into the shape the React frontend expects
function mapOrderToApi(order) {
  if (!order) return null;

  const { shipper, assignedRider, statusEvents, ...o } = order;

  const base = {
    ...o,
    id: o.id,
    _id: o.id,
  };

  // Backwards-compatible activity timeline used by CEO dashboard and
  // other legacy UIs that expect `statusHistory` on the order object.
  if (Array.isArray(statusEvents) && statusEvents.length) {
    base.statusHistory = statusEvents.map((ev) => ({
      status: ev.status,
      timestamp: ev.createdAt,
      note: ev.note,
      updatedBy: ev.createdById,
    }));
  } else {
    // Fallback: synthesize a minimal history entry from the current
    // order status so activity feeds are never completely empty, even
    // for legacy orders created before OrderEvent was introduced.
    base.statusHistory = [
      {
        status: o.status,
        timestamp: o.updatedAt || o.createdAt,
        note: null,
        updatedBy: null,
      },
    ];
  }

  // Surface Shopify order number explicitly for integrated orders so
  // frontends don't have to know about internal column naming.
  // Fallback to externalOrderId for generic integrations that don't
  // populate sourceProviderOrderNumber.
  base.shopifyOrderNumber =
    o.sourceProviderOrderNumber || o.externalOrderId || null;

  if (shipper) {
    base.shipper = {
      _id: shipper.id,
      id: shipper.id,
      name: shipper.name,
      email: shipper.email,
      companyName: shipper.companyName,
      phone: shipper.phone,
    };
  } else if (o.shipperId != null) {
    base.shipper = o.shipperId;
  }

  if (assignedRider) {
    base.assignedRider = {
      _id: assignedRider.id,
      id: assignedRider.id,
      name: assignedRider.name,
      phone: assignedRider.phone,
    };
  } else if (o.assignedRiderId != null) {
    base.assignedRider = o.assignedRiderId;
  }

  return base;
}

/**
 * Create a new order (manual shipper flow)
 */
const createOrder = async (req, res, next) => {
  try {
    const {
      consigneeName, consigneePhone, consigneeAddress, destinationCity,
      serviceType, codAmount, productDescription, pieces, fragile, remarks, paymentType,
      weightKg // NEW
    } = req.body;

    if (!productDescription || !String(productDescription).trim()) {
      return res.status(400).json({ message: 'Product description is required' });
    }

    if (!weightKg || weightKg <= 0) {
      return res.status(400).json({ message: 'weightKg required and must be > 0' });
    }

    const shipperId = Number(req.user.id);
    if (!Number.isInteger(shipperId) || shipperId <= 0) {
      return res.status(400).json({ message: 'Invalid shipper id' });
    }

    const bookingId = await generateBookingId();
    const trackingId = await generateTrackingId();

    // Commission Config/weight-based logic via Prisma (single-rule + legacy
    // brackets fallback handled by computeServiceChargeKgBased)
    const commissionConfig = await prisma.commissionConfig.findUnique({
      where: { shipperId },
      include: { weightBrackets: true },
    });

    if (!commissionConfig) {
      return res
        .status(400)
        .json({ message: 'No commission configuration found for this shipper' });
    }

    const numericWeight = Number(weightKg);
    const { serviceCharges, rule } = computeServiceChargeKgBased(
      numericWeight,
      commissionConfig,
    );

    if (!rule) {
      return res
        .status(400)
        .json({ message: 'No commission rule configured for this shipper' });
    }

    if (!serviceCharges || serviceCharges <= 0) {
      return res.status(400).json({
        message: 'No commission rule matched for this weight for this shipper',
      });
    }

    const numericCod = Number(codAmount || 0);
    const effectivePaymentType = paymentType || (numericCod > 0 ? 'COD' : 'ADVANCE');
    const effectiveCodAmount = effectivePaymentType === 'ADVANCE' ? 0 : numericCod;

    const created = await prisma.order.create({
      data: {
        bookingId,
        trackingId,
        shipperId,
        consigneeName,
        consigneePhone,
        consigneeAddress,
        destinationCity,
        serviceType: serviceType || 'SAME_DAY',
        paymentType: effectivePaymentType,
        codAmount: effectiveCodAmount,
        productDescription,
        pieces: Number(pieces || 1),
        fragile: !!fragile,
        weightKg: numericWeight,
        serviceCharges,
        totalAmount: effectiveCodAmount + serviceCharges,
        remarks,
        status: 'CREATED',
        isIntegrated: false,
        bookingState: 'BOOKED',
        bookedWithLLL: true,
        isDeleted: false,
        shipperApprovalStatus: 'approved',
        source: 'MANUAL',
      },
      include: {
        shipper: {
          select: { id: true, name: true, email: true, companyName: true, phone: true },
        },
        assignedRider: {
          select: { id: true, name: true, phone: true },
        },
      },
    });

    res.status(201).json(mapOrderToApi(created));
  } catch (err) {
    next(err);
  }
};

const getOrders = async (req, res, next) => {
  try {
    const { role, id } = req.user;
    const { status, from, to, q } = req.query;

    const where = { isDeleted: false };

    if (role === 'SHIPPER') {
      where.shipperId = id;
    } else if (role === 'RIDER') {
      where.assignedRiderId = id;
      where.bookingState = 'BOOKED';
    } else if (['CEO', 'MANAGER'].includes(role)) {
      where.OR = [
        { isIntegrated: false },
        { isIntegrated: true, bookingState: 'BOOKED' },
      ];
    }

    if (status) {
      where.status = status;
    }

    if (from || to) {
      const createdAt = {};
      if (from) {
        const d = new Date(from);
        if (!Number.isNaN(d.getTime())) createdAt.gte = d;
      }
      if (to) {
        const d = new Date(to);
        if (!Number.isNaN(d.getTime())) createdAt.lte = d;
      }
      if (Object.keys(createdAt).length) {
        where.createdAt = createdAt;
      }
    }

    if (q && q.trim()) {
      const searchId = q.trim();
      // For search, override visibility logic like the legacy Mongo query did.
      // Allow lookup by Tracking ID (primary), Booking ID, or external
      // provider order number (e.g. Shopify order number).
      where.OR = [
        { trackingId: searchId },
        { bookingId: searchId },
        { sourceProviderOrderNumber: searchId },
      ];
    }

    const orders = await prisma.order.findMany({
      where,
      include: {
        shipper: {
          select: { id: true, name: true, email: true, companyName: true, phone: true },
        },
        assignedRider: {
          select: { id: true, name: true, phone: true },
        },
        // Expose normalized status events so we can derive legacy
        //-style statusHistory for activity feeds.
        statusEvents: {
          orderBy: { createdAt: 'asc' },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    res.json(orders.map(mapOrderToApi));
  } catch (error) {
    next(error);
  }
};

const getManagerOverview = async (req, res, next) => {
  try {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const end = new Date();
    end.setHours(23, 59, 59, 999);

    const visibility = {
      OR: [
        { isIntegrated: false },
        { isIntegrated: true, bookingState: 'BOOKED' },
      ],
    };

    const todayFilter = {
      createdAt: { gte: start, lte: end },
      ...visibility,
    };

    const [
      todayReceived,
      todayBooked,
      todayUnbooked,
      warehouseCount,
      outForDeliveryCount,
      returnedCount,
      pendingReviewCountAgg,
    ] = await Promise.all([
      prisma.order.count({ where: todayFilter }),
      prisma.order.count({
        where: { ...todayFilter, assignedRiderId: { not: null } },
      }),
      prisma.order.count({ where: { ...todayFilter, assignedRiderId: null } }),
      prisma.order.count({
        where: { status: 'ASSIGNED', ...visibility },
      }),
      prisma.order.count({
        where: { status: 'OUT_FOR_DELIVERY', ...visibility },
      }),
      prisma.order.count({ where: { status: 'RETURNED', ...visibility } }),
      prisma.financialTransaction.count({
        where: { settlementStatus: 'PENDING' },
      }),
    ]);

    res.json({
      todayReceived,
      todayBooked,
      todayUnbooked,
      warehouseCount,
      outForDeliveryCount,
      returnedCount,
      deliveryUnderReviewCount: pendingReviewCountAgg,
    });
  } catch (error) {
    next(error);
  }
};

const getOrderById = async (req, res, next) => {
  try {
    const rawId = req.params.id;
    const orderId = Number(rawId);
    if (!Number.isInteger(orderId) || orderId <= 0) {
      return res.status(400).json({ message: 'Invalid order id' });
    }

    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: {
        shipper: { select: { id: true, name: true, email: true, companyName: true } },
        assignedRider: { select: { id: true, name: true, phone: true } },
      },
    });

    if (!order) return res.status(404).json({ message: 'Order not found' });

    const userId = req.user.id;
    const role = req.user.role;
    if (role === 'SHIPPER' && order.shipperId !== userId) {
      return res.status(403).json({ message: 'Forbidden' });
    }
    if (role === 'RIDER' && order.assignedRiderId !== userId) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    res.json(mapOrderToApi(order));
  } catch (error) {
    next(error);
  }
};

const ceoEditOrder = async (req, res, next) => {
  try {
    const rawId = req.params.id;
    const orderId = Number(rawId);

    if (!Number.isInteger(orderId) || orderId <= 0) {
      return res.status(400).json({ message: 'Invalid order id' });
    }

    const role = req.user && req.user.role;
    const rawUserId = req.user && (req.user.id || req.user._id);
    const editedById = Number(rawUserId);

    if (role !== 'CEO') {
      return res.status(403).json({ message: 'Only CEO can edit orders' });
    }
    if (!Number.isInteger(editedById) || editedById <= 0) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const reasonRaw = req.body && req.body.reason;
    const reason = typeof reasonRaw === 'string' ? reasonRaw.trim() : '';
    if (!reason) {
      return res.status(400).json({ message: 'Reason for change is required' });
    }

    const existing = await prisma.order.findUnique({
      where: { id: orderId },
      include: {
        financialTransaction: true,
        invoice: true,
      },
    });

    if (!existing) {
      return res.status(404).json({ message: 'Order not found' });
    }

    const statusUpper = String(existing.status || '').toUpperCase();
    const isFinalStatus = ['DELIVERED', 'RETURNED', 'FAILED'].includes(
      statusUpper,
    );

    const tx = existing.financialTransaction;
    const settlementStatusUpper = tx?.settlementStatus
      ? String(tx.settlementStatus).toUpperCase()
      : null;
    const isSettled =
      settlementStatusUpper && ['PAID', 'SETTLED'].includes(settlementStatusUpper);

    const isInvoiced = !!existing.invoiceId;

    if (isFinalStatus || isSettled || isInvoiced) {
      return res.status(400).json({
        message:
          'This order is locked (delivered/returned/settled/invoiced) and cannot be edited.',
      });
    }

    const {
      paymentType: paymentTypeRaw,
      codAmount: codAmountRaw,
      serviceCharges: serviceChargesRaw,
      fragile: fragileRaw,
      pieces: piecesRaw,
      weightKg: weightKgRaw,
      consigneeName: consigneeNameRaw,
      consigneePhone: consigneePhoneRaw,
      consigneeAddress: consigneeAddressRaw,
      destinationCity: destinationCityRaw,
      remarks: remarksRaw,
    } = req.body || {};

    const updates = {};

    // Start from existing finance values and adjust based on inputs.
    let newPaymentType = existing.paymentType;
    let newCodAmount = existing.codAmount;
    let newServiceCharges = existing.serviceCharges;

    if (typeof paymentTypeRaw !== 'undefined') {
      const pt = String(paymentTypeRaw).toUpperCase();
      if (!['COD', 'ADVANCE'].includes(pt)) {
        return res.status(400).json({ message: 'Invalid payment type' });
      }
      newPaymentType = pt;
      updates.paymentType = pt;
    }

    if (typeof codAmountRaw !== 'undefined') {
      const codNum = Number(codAmountRaw);
      if (!Number.isFinite(codNum) || codNum < 0) {
        return res
          .status(400)
          .json({ message: 'codAmount must be a non-negative number' });
      }
      newCodAmount = codNum;
    }

    if (newPaymentType === 'ADVANCE') {
      newCodAmount = 0;
      updates.codAmount = 0;
    } else if (typeof codAmountRaw !== 'undefined') {
      updates.codAmount = newCodAmount;
    }

    if (typeof serviceChargesRaw !== 'undefined') {
      const scNum = Number(serviceChargesRaw);
      if (!Number.isFinite(scNum) || scNum < 0) {
        return res
          .status(400)
          .json({ message: 'serviceCharges must be a non-negative number' });
      }
      newServiceCharges = scNum;
      updates.serviceCharges = scNum;
    }

    if (typeof fragileRaw !== 'undefined') {
      updates.fragile = Boolean(fragileRaw);
    }

    if (typeof piecesRaw !== 'undefined') {
      const piecesNum = Number(piecesRaw);
      if (!Number.isInteger(piecesNum) || piecesNum <= 0) {
        return res
          .status(400)
          .json({ message: 'pieces must be a positive integer' });
      }
      updates.pieces = piecesNum;
    }

    if (typeof weightKgRaw !== 'undefined') {
      const weightNum = Number(weightKgRaw);
      if (!Number.isFinite(weightNum) || weightNum <= 0) {
        return res
          .status(400)
          .json({ message: 'weightKg must be a positive number' });
      }
      updates.weightKg = weightNum;
    }

    if (typeof consigneeNameRaw !== 'undefined') {
      const name = String(consigneeNameRaw).trim();
      if (!name) {
        return res
          .status(400)
          .json({ message: 'consigneeName is required and cannot be empty' });
      }
      updates.consigneeName = name;
    }

    if (typeof consigneePhoneRaw !== 'undefined') {
      const phone = String(consigneePhoneRaw).trim();
      const digits = phone.replace(/[^0-9]/g, '');
      if (digits.length < 7 || digits.length > 15) {
        return res.status(400).json({ message: 'Invalid consigneePhone format' });
      }
      updates.consigneePhone = phone;
    }

    if (typeof consigneeAddressRaw !== 'undefined') {
      const addr = String(consigneeAddressRaw).trim();
      if (!addr) {
        return res
          .status(400)
          .json({ message: 'consigneeAddress is required and cannot be empty' });
      }
      updates.consigneeAddress = addr;
    }

    if (typeof destinationCityRaw !== 'undefined') {
      const city = String(destinationCityRaw).trim();
      if (!city) {
        return res
          .status(400)
          .json({ message: 'destinationCity is required and cannot be empty' });
      }
      updates.destinationCity = city;
    }

    if (typeof remarksRaw !== 'undefined') {
      const remarks =
        remarksRaw === null || typeof remarksRaw === 'undefined'
          ? null
          : String(remarksRaw).trim();
      updates.remarks = remarks;
    }

    const codForTotal =
      typeof updates.codAmount !== 'undefined'
        ? updates.codAmount
        : existing.codAmount;
    const svcForTotal =
      typeof updates.serviceCharges !== 'undefined'
        ? updates.serviceCharges
        : existing.serviceCharges;

    if (
      typeof updates.codAmount !== 'undefined' ||
      typeof updates.serviceCharges !== 'undefined' ||
      typeof updates.paymentType !== 'undefined'
    ) {
      updates.totalAmount = codForTotal + svcForTotal;
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ message: 'No editable fields provided' });
    }

    const toSnapshot = (obj) => JSON.parse(JSON.stringify(obj));
    const beforeSnapshot = toSnapshot(existing);

    const ipHeader = req.headers['x-forwarded-for'] || req.ip || '';
    const ip =
      typeof ipHeader === 'string'
        ? ipHeader.split(',')[0].trim()
        : Array.isArray(ipHeader)
          ? ipHeader[0]
          : '';
    const userAgent = req.get('user-agent') || null;

    const updated = await prisma.$transaction(async (tx) => {
      const updatedOrder = await tx.order.update({
        where: { id: orderId },
        data: updates,
        include: {
          shipper: {
            select: {
              id: true,
              name: true,
              email: true,
              companyName: true,
              phone: true,
            },
          },
          assignedRider: {
            select: { id: true, name: true, phone: true },
          },
        },
      });

      const afterSnapshot = toSnapshot(updatedOrder);

      await tx.orderEditLog.create({
        data: {
          orderId,
          editedById,
          reason,
          before: beforeSnapshot,
          after: afterSnapshot,
          ip: ip || null,
          userAgent,
        },
      });

      return updatedOrder;
    });

    res.json(mapOrderToApi(updated));
  } catch (error) {
    next(error);
  }
};

const assignRider = async (req, res, next) => {
  try {
    const rawId = req.params.id;
    const orderId = Number(rawId);
    const riderIdNum = req.body.riderId ? Number(req.body.riderId) : null;

    if (!Number.isInteger(orderId) || orderId <= 0) {
      return res.status(400).json({ message: 'Invalid order id' });
    }

    if (riderIdNum !== null && (!Number.isInteger(riderIdNum) || riderIdNum <= 0)) {
      return res.status(400).json({ message: 'Invalid rider id' });
    }

    const existing = await prisma.order.findUnique({ where: { id: orderId } });
    if (!existing) {
      return res.status(404).json({ message: 'Order not found' });
    }

    const previousRiderId = existing.assignedRiderId;
    const nextStatus =
      riderIdNum && existing.status === 'CREATED' ? 'ASSIGNED' : existing.status;

    const updated = await prisma.order.update({
      where: { id: orderId },
      data: {
        assignedRiderId: riderIdNum,
        status: nextStatus,
        statusEvents: {
          create: {
            status: nextStatus,
            note:
              riderIdNum != null
                ? `Assigned to rider ${riderIdNum}`
                : `Unassigned from rider ${previousRiderId ?? ''}`,
            createdById: Number(req.user.id) || null,
          },
        },
      },
      include: {
        shipper: { select: { id: true, name: true, email: true, companyName: true } },
        assignedRider: { select: { id: true, name: true, phone: true } },
      },
    });

    res.json(mapOrderToApi(updated));
  } catch (error) {
    next(error);
  }
};

const createFinancialTransaction = async (order) => {
  try {
    const finalStatus = String(order.status || '').toUpperCase();
    const isDelivered = finalStatus === 'DELIVERED';

    // Only create transactions for final rider-impacting statuses
    if (!['DELIVERED', 'RETURNED', 'FAILED'].includes(finalStatus)) {
      return;
    }

    const codCollected =
      isDelivered && order.paymentType === 'COD'
        ? Number(order.amountCollected ?? order.codAmount ?? 0)
        : 0;
    const originalCod = Number(order.codAmount || 0);

    const cfg = await prisma.commissionConfig.findUnique({
      where: { shipperId: order.shipperId },
    });

    let companyCommission = 0;
    if (cfg) {
      if (cfg.type === 'PERCENTAGE') {
        companyCommission = Math.round((codCollected * cfg.value) / 100);
      } else {
        companyCommission = cfg.value;
      }
    }

    let riderCommission = 0;
    if (order.assignedRiderId) {
      const riderCfg = await prisma.riderCommissionConfig.findUnique({
        where: { riderId: order.assignedRiderId },
        include: { rules: true },
      });

      if (riderCfg) {
        const codBase = isDelivered ? codCollected : originalCod;

        const applyRule = (type, value) => {
          const numericValue = Number(value || 0);
          if (type === 'PERCENTAGE') {
            return Math.round((Number(codBase || 0) * numericValue) / 100);
          }
          return numericValue;
        };

        const rulesArray = Array.isArray(riderCfg.rules) ? riderCfg.rules : [];
        const rule = rulesArray.find((r) => r.status === finalStatus) || null;

        if (rule && rule.value != null) {
          const typeToUse = rule.type || riderCfg.type || 'FLAT';
          riderCommission = applyRule(typeToUse, rule.value);
        } else if (riderCfg.type && riderCfg.value != null) {
          riderCommission = applyRule(riderCfg.type, riderCfg.value);
        }
      }
    }

    // For delivered COD orders, do not allow rider commission to exceed collected COD.
    if (isDelivered) {
      const codForClamp = codCollected;
      if (codForClamp > 0 && riderCommission > codForClamp) {
        riderCommission = codForClamp;
      }
    }

    companyCommission = Math.min(companyCommission, codCollected);
    const shipperShare = codCollected - companyCommission;

    await prisma.financialTransaction.upsert({
      where: { orderId: order.id },
      update: {
        shipperId: order.shipperId,
        riderId: order.assignedRiderId ?? null,
        totalCodCollected: codCollected,
        shipperShare,
        companyCommission,
        riderCommission,
      },
      create: {
        orderId: order.id,
        shipperId: order.shipperId,
        riderId: order.assignedRiderId ?? null,
        totalCodCollected: codCollected,
        shipperShare,
        companyCommission,
        riderCommission,
      },
    });
  } catch (err) {
    console.error('Error creating financial transaction (prisma):', err);
  }
};

const updateRiderFinance = async (order) => {
  try {
    if (!order.assignedRiderId) return;

    const riderProfile = await prisma.riderProfile.findUnique({
      where: { userId: order.assignedRiderId },
    });

    const cod = Number(order.amountCollected ?? order.codAmount ?? 0);
    const svc = Number(order.serviceCharges ?? 0);

    if (!riderProfile) {
      await prisma.riderProfile.create({
        data: {
          userId: order.assignedRiderId,
          codCollected: cod,
          serviceCharges: svc,
          serviceChargeStatus: 'unpaid',
        },
      });
      return;
    }

    const updateData = {
      codCollected: riderProfile.codCollected + cod,
    };

    if (riderProfile.serviceChargeStatus === 'unpaid') {
      updateData.serviceCharges = (riderProfile.serviceCharges || 0) + svc;
    }

    await prisma.riderProfile.update({
      where: { id: riderProfile.id },
      data: updateData,
    });
  } catch (err) {
    console.error('Error updating rider finance (prisma):', err);
  }
};

const updateStatus = async (req, res, next) => {
  try {
    const rawId = req.params.id;
    const orderId = Number(rawId);
    const { status, amountCollected, reason } = req.body;

    if (!Number.isInteger(orderId) || orderId <= 0) {
      return res.status(400).json({ message: 'Invalid order id' });
    }

    const validStatuses = [
      'OUT_FOR_DELIVERY',
      'DELIVERED',
      'RETURNED',
      'FAILED',
      'FIRST_ATTEMPT',
      'SECOND_ATTEMPT',
      'THIRD_ATTEMPT',
    ];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ message: 'Invalid status for update' });
    }

    const existing = await prisma.order.findUnique({
      where: { id: orderId },
      include: { shipper: true, assignedRider: true },
    });

    if (!existing) {
      return res.status(404).json({ message: 'Order not found' });
    }

    if (req.user.role === 'RIDER') {
      if (!existing.assignedRiderId || existing.assignedRiderId !== req.user.id) {
        return res.status(403).json({
          message: 'You can only update status for orders assigned to you',
        });
      }
    }

    const previousStatus = existing.status;

    const data = {
      status,
    };

    let amountToSet = existing.amountCollected;
    if (status === 'DELIVERED') {
      const parsed = Number(amountCollected);
      amountToSet = !Number.isNaN(parsed) && parsed >= 0 ? parsed : existing.codAmount;
      data.deliveredAt = new Date();
      data.amountCollected = amountToSet;

      try {
        const commissionConfig = await prisma.commissionConfig.findUnique({
          where: { shipperId: existing.shipperId },
          include: { weightBrackets: true },
        });

        if (commissionConfig) {
          const numericWeight = Number(existing.weightKg || 0);
          if (Number.isFinite(numericWeight) && numericWeight > 0) {
            const { serviceCharges, rule } = computeServiceChargeKgBased(
              numericWeight,
              commissionConfig,
            );

            if (rule && Number.isFinite(serviceCharges) && serviceCharges >= 0) {
              data.serviceCharges = serviceCharges;
            }
          }
        }
      } catch (scErr) {
        console.error(
          'Error recalculating service charges on delivery for order',
          orderId,
          scErr,
        );
      }
    } else if (status === 'FAILED' || status === 'RETURNED') {
      data.failedReason = reason;
    }

    // Apply flat return service charge configured per shipper when order is RETURNED.
    // This overrides any existing weight-based service charges for returned orders.
    if (status === 'RETURNED') {
      try {
        const cfg = await prisma.commissionConfig.findUnique({
          where: { shipperId: existing.shipperId },
        });
        if (cfg && typeof cfg.returnCharge === 'number') {
          const rc = Number(cfg.returnCharge || 0);
          if (!Number.isNaN(rc) && rc >= 0) {
            data.serviceCharges = rc;
          }
        }
      } catch (cfgErr) {
        console.error(
          'Error applying returnCharge for shipper',
          existing.shipperId,
          cfgErr,
        );
      }
    }

    const updated = await prisma.order.update({
      where: { id: orderId },
      data: {
        ...data,
        statusEvents: {
          create: {
            status,
            note: reason || `Status updated to ${status}`,
            createdById: Number(req.user.id) || null,
          },
        },
      },
      include: {
        shipper: true,
        assignedRider: true,
      },
    });

    if (['DELIVERED', 'RETURNED', 'FAILED'].includes(status) && previousStatus !== status) {
      await createFinancialTransaction(updated);

      if (updated.assignedRiderId && status === 'DELIVERED') {
        await updateRiderFinance(updated);
      }
    }

    res.json(mapOrderToApi(updated));
  } catch (error) {
    next(error);
  }
};

const getLabel = async (req, res, next) => {
  try {
    const rawId = req.params.id;
    const orderId = Number(rawId);
    if (!Number.isInteger(orderId) || orderId <= 0) {
      return res.status(400).json({ message: 'Invalid order id' });
    }

    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: {
        shipper: { select: { id: true, name: true, companyName: true } },
      },
    });

    if (!order) {
      return res.status(404).json({ message: 'Order not found' });
    }

    const userId = req.user.id;
    const role = req.user.role;

    if (role === 'SHIPPER' && order.shipperId !== userId) {
      return res.status(403).json({ message: 'Forbidden' });
    }
    if (role === 'RIDER' && order.assignedRiderId !== userId) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    const externalOrderNumber =
      order.sourceProviderOrderNumber || order.externalOrderId || null;
    const isIntegrated = !!order.isIntegrated;
    const displayOrderNumber = externalOrderNumber || order.bookingId;

    const labelData = {
      bookingId: order.bookingId,
      trackingId: order.trackingId,
      isIntegrated,
      shopifyOrderNumber: externalOrderNumber,
      displayOrderNumber,
      consignee: {
        name: order.consigneeName,
        phone: order.consigneePhone,
        address: order.consigneeAddress,
        destinationCity: order.destinationCity,
      },
      shipper: {
        name: order.shipper?.name || 'N/A',
        companyName: order.shipper?.companyName || 'N/A',
        serviceType: order.serviceType,
      },
      order: {
        codAmount: order.codAmount,
        serviceCharges: order.serviceCharges || 0,
        paymentType: order.paymentType,
        productDescription: order.productDescription,
        pieces: order.pieces,
        fragile: order.fragile,
        createdAt: order.createdAt,
        isIntegrated,
        shopifyOrderNumber: externalOrderNumber,
      },
    };

    res.json(labelData);
  } catch (error) {
    next(error);
  }
};

const getLabels = async (req, res, next) => {
  try {
    const { ids } = req.query;
    if (!ids) return res.status(400).json({ message: 'ids query is required' });
    const idList = ids
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n > 0);
    if (idList.length === 0) {
      return res.status(400).json({ message: 'No ids provided' });
    }

    const orders = await prisma.order.findMany({
      where: { id: { in: idList } },
      include: { shipper: { select: { id: true, name: true, companyName: true } } },
    });

    if (!orders || orders.length === 0) {
      return res.status(404).json({ message: 'Orders not found' });
    }

    const userId = req.user.id;
    const role = req.user.role;

    const permitted = orders.filter((order) => {
      if (role === 'SHIPPER') return order.shipperId === userId;
      if (role === 'RIDER') return order.assignedRiderId === userId;
      return true;
    });

    const labels = permitted.map((order) => {
      const externalOrderNumber =
        order.sourceProviderOrderNumber || order.externalOrderId || null;
      const isIntegrated = !!order.isIntegrated;
      const displayOrderNumber = externalOrderNumber || order.bookingId;

      return {
        bookingId: order.bookingId,
        trackingId: order.trackingId,
        isIntegrated,
        shopifyOrderNumber: externalOrderNumber,
        displayOrderNumber,
        consignee: {
          name: order.consigneeName,
          phone: order.consigneePhone,
          address: order.consigneeAddress,
          destinationCity: order.destinationCity,
        },
        shipper: {
          name: order.shipper?.name || 'N/A',
          companyName: order.shipper?.companyName || 'N/A',
          serviceType: order.serviceType,
        },
        order: {
          codAmount: order.codAmount,
          serviceCharges: order.serviceCharges || 0,
          paymentType: order.paymentType,
          productDescription: order.productDescription,
          pieces: order.pieces,
          fragile: order.fragile,
          createdAt: order.createdAt,
          isIntegrated,
          shopifyOrderNumber: externalOrderNumber,
        },
      };
    });

    res.json({ count: labels.length, labels });
  } catch (error) {
    next(error);
  }
};

const printLabelsHtml = async (req, res, next) => {
  try {
    const shipperId = req.user.id;
    const rawIds = Array.isArray(req.body.orderIds) ? req.body.orderIds : [];
    const ids = rawIds.map((s) => Number(String(s))).filter((n) => Number.isInteger(n) && n > 0);
    if (!ids.length) return res.status(400).send('No orderIds provided');

    const orders = await prisma.order.findMany({
      where: { id: { in: ids }, shipperId },
      include: { shipper: { select: { name: true, companyName: true, phone: true, pickupAddress: true } } },
    });
    if (!orders.length) return res.status(404).send('Orders not found');

    const patterns = {
      '0': '101001101101', '1': '110100101011', '2': '101100101011', '3': '110110010101',
      '4': '101001101011', '5': '110100110101', '6': '101100110101', '7': '101001011011',
      '8': '110100101101', '9': '101100101101', '*': '100101101101'
    };
    const barcodeSvg = (val) => {
      const text = `*${String(val).toUpperCase()}*`;
      let seq = '';
      for (const ch of text) { seq += (patterns[ch] || patterns['0']) + '0'; }
      let x = 0; const barWidth = 1; const height = 35; const rects = [];
      for (const bit of seq) { if (bit === '1') rects.push(`<rect x=\"${x}\" y=\"0\" width=\"${barWidth}\" height=\"${height}\" fill=\"#000\" />`); x += barWidth; }
      return `<svg width=\"180\" height=\"${height}\" viewBox=\"0 0 ${x} ${height}\" xmlns=\"http://www.w3.org/2000/svg\" shape-rendering=\"crispEdges\" style=\"max-width: 100%; height: auto;\">${rects.join('')}</svg>`;
    };

    const labelsWithQr = await Promise.all(orders.map(async (o) => {
      const externalOrderNumber =
        o.sourceProviderOrderNumber || o.externalOrderId || null;
      const isIntegrated = !!o.isIntegrated;
      const displayOrderNumber = externalOrderNumber || o.bookingId;
      const codAmount = Number(o.codAmount || 0);
      const finalAmount = codAmount;
      const cod = Number(finalAmount || 0).toLocaleString();
      const created = new Date(o.createdAt).toISOString().split('T')[0];
      const trackingBarcode = barcodeSvg(String(o.trackingId || '').replace(/[^0-9]/g, ''));
      const orderBarcode = barcodeSvg(String(displayOrderNumber || '').replace(/[^0-9]/g, ''));
      const codBarcode = barcodeSvg(String(finalAmount).replace(/[^0-9]/g, ''));
      const shipperName = o.shipper?.name || 'N/A';
      const shipperAddress = o.shipper?.address || o.shipper?.companyName || 'N/A';
      const shipperPhone = o.shipper?.phone || 'N/A';
      const service = o.paymentType || o.serviceType || 'COD';
      const weightVal = o.weight || '0.5 KG';
      const fragileVal = o.fragile ? 'true' : 'false';
      const piecesVal = o.pieces || 1;
      const rawRemarks = (o.remarks || '').trim();
      const remarksVal = rawRemarks || (o.fragile ? 'FRAGILE - Handle with care' : '');
      const products = o.productDescription || 'N/A';
      const warehouseQrContent = `LLL|${o.bookingId || ''}`;
      const warehouseQrDataUrl = await QRCode.toDataURL(warehouseQrContent, { margin: 0, width: 90 });
      const websiteUrl = process.env.APP_BASE_URL || 'https://lahorelinklogistics.com';
      const websiteQrDataUrl = await QRCode.toDataURL(websiteUrl, { margin: 0, width: 90 });
      const logoUrl = `/logo.png`;
      return {
        html: `
      <div class=\"label-card\">
        <div class=\"top-section\">
          <div class=\"grid-cols-12\">
            <div class=\"col-4\">
              <div class=\"section-header\">Customer Information</div>
              <div class=\"section-content\">
                <div class=\"info-row\"><span class=\"label\">Name:</span> <span class=\"value\">${o.consigneeName}</span></div>
                <div class=\"info-row\"><span class=\"label\">Phone:</span> <span class=\"value\">${o.consigneePhone}</span></div>
                <div class=\"info-row\"><span class=\"label\">Address:</span> <span>${o.consigneeAddress}</span></div>
                <div class=\"divider\"></div>
                <div class=\"destination\">Destination: ${o.destinationCity}</div>
                <div class=\"divider\"></div>
                <div class=\"order-row\">
                  <span class=\"order-label\">Order: ${displayOrderNumber}</span>
                  <div class=\"barcode-container\">${orderBarcode}</div>
                  <div class=\"order-qr\">
                    <img src=\"${warehouseQrDataUrl}\" alt=\"QR ${warehouseQrContent}\" class=\"qr-img-small\" />
                  </div>
                </div>
              </div>
            </div>
            <div class=\"col-4\">
              <div class=\"section-header\">Brand Information</div>
              <div class=\"section-content\">
                <div class=\"info-row-flex\">
                  <span class=\"label\">Shipper: ${shipperName}</span>
                  <span class=\"value\">${shipperPhone}</span>
                </div>
                <div class=\"info-row\"><span class=\"label\">Shipper Address:</span> <span>${shipperAddress}</span></div>
              </div>
              <div class=\"amount-box\">
                <div class=\"amount-label\">Amount</div>
                <div class=\"amount-value\">Rs ${cod}</div>
                <div class=\"barcode-container\">${codBarcode}</div>
              </div>
            </div>
            <div class=\"col-4\">
              <div class=\"section-header\">Parcel Information</div>
              <div class=\"logo-section\">
                <div class=\"logo-container\">
                  <img src=\"${logoUrl}\" alt=\"LahoreLink Logistics\" class=\"logo-img\" />
                </div>
                <div class=\"qr-box\">
                  <img src=\"${websiteQrDataUrl}\" alt=\"Website QR\" class=\"qr-img\" />
                  <div class=\"qr-caption\">Track at<br/>lahorelinklogistics.com</div>
                </div>
              </div>
              <div class=\"tracking-barcode-container\">
                ${trackingBarcode}
                <div class=\"tracking-id\">${o.trackingId}</div>
              </div>
              <div class=\"parcel-details\">
                <div class=\"detail-row\">Service: ${service}</div>
                <div class=\"detail-grid\">
                  <div class=\"detail-cell\">Date: ${created}</div>
                  <div class=\"detail-cell-right\">Weight: ${weightVal}</div>
                </div>
                <div class=\"detail-grid\">
                  <div class=\"detail-cell\">Fragile: ${fragileVal}</div>
                  <div class=\"detail-cell-right\">Pieces: ${piecesVal}</div>
                </div>
              </div>
            </div>
          </div>
        </div>
        <div class=\"remarks-section\">
          <span class=\"remarks-label\">Remarks:</span>
          <span class=\"remarks-value\">${remarksVal ? '- ' + remarksVal : ''}</span>
        </div>
        <div class=\"products-section\">
          <span class=\"products-label\">Products:</span>
          <span class=\"products-value\">[ ${piecesVal} x ${products} ]</span>
        </div>
      </div>
        `
      };
    }));

    const labelsHtml = labelsWithQr.map(l => l.html).join('');

    const html = `<!doctype html>
<html>
<head>
  <meta charset=\"utf-8\" />
  <title>Labels</title>
  <style>
    @page { size: A4 portrait; margin: 5mm; }
    body { font-family: Arial, Helvetica, sans-serif; margin: 0; padding: 0; background: white; }
    .wrap { max-width: 800px; margin: 0 auto; padding: 10px; }
    .label-card { 
      background: white; 
      color: black; 
      width: 100%; 
      max-width: 800px; 
      border: 2px solid #000; 
      box-sizing: border-box; 
      margin-bottom: 5px;
      height: 93mm;
      overflow: hidden;
      page-break-inside: avoid;
    }
    .top-section { padding: 0; }
    .grid-cols-12 { 
      display: grid; 
      grid-template-columns: 1fr 1fr 1fr; 
      border-left: 2px solid #000;
      border-right: 2px solid #000;
    }
    .col-4 { 
      border-right: 2px solid #000; 
      display: flex; 
      flex-direction: column;
    }
    .col-4:last-child { border-right: none; }
    .section-header { 
      border-bottom: 2px solid #000; 
      text-align: center; 
      font-weight: bold; 
      font-size: 12px; 
      padding: 4px 2px;
      text-transform: capitalize;
    }
    .section-content { 
      padding: 4px; 
      font-size: 9px; 
      line-height: 1.2;
      flex-grow: 1;
    }
    .info-row { margin: 2px 0; }
    .info-row-flex { 
      display: flex; 
      justify-content: space-between; 
      align-items: start; 
      margin: 2px 0;
      font-size: 9px;
    }
    .label { font-weight: bold; color: #666; margin-right: 4px; }
    .value { font-weight: bold; }
    .divider { border-top: 1px solid #000; margin: 4px 0; }
    .destination { font-weight: bold; font-size: 10px; margin-top: 2px; }
    .order-row { margin-top: 4px; }
    .order-qr { margin-top: 2px; display: flex; justify-content: center; }
    .order-label { font-weight: bold; }
    .barcode-container { 
      margin: 2px 0; 
      text-align: center; 
      padding: 2px;
      background: white;
    }
    .amount-box { 
      border-top: 2px solid #000; 
      flex-grow: 1; 
      display: flex; 
      flex-direction: column; 
      align-items: center; 
      justify-content: center; 
      padding: 4px;
    }
    .amount-label { font-size: 8px; margin-bottom: 1px; }
    .amount-value { font-weight: 900; font-size: 14px; margin-bottom: 2px; }
    .logo-section { 
      display: flex; 
        align-items: center; 
        justify-content: space-between; 
      padding: 4px; 
      border-bottom: 1px solid #000;
    }
    .logo-container { display: flex; align-items: center; }
      .logo-img { height: 40px; width: auto; }
      .qr-box { display: flex; flex-direction: column; align-items: center; gap: 2px; }
      .qr-img { width: 70px; height: 70px; object-fit: contain; }
    .qr-img-small { width: 50px; height: 50px; object-fit: contain; }
      .qr-caption { font-size: 7px; line-height: 1.1; text-align: center; }
    .tracking-barcode-container { 
      padding: 4px; 
      display: flex; 
      flex-direction: column; 
      align-items: center; 
      border-bottom: 1px solid #000;
    }
    .tracking-id { font-size: 8px; font-weight: bold; margin-top: 2px; }
    .parcel-details { 
      flex-grow: 1; 
      font-size: 9px; 
      font-weight: bold;
    }
    .detail-row { padding: 2px 4px; border-bottom: 1px solid #000; }
    .detail-grid { 
      display: grid; 
      grid-template-columns: 1fr 1fr; 
      border-bottom: 1px solid #000;
    }
    .detail-cell { padding: 2px 4px; border-right: 1px solid #000; }
    .detail-cell-right { padding: 2px 4px; text-align: right; }
    .remarks-section { 
      border-top: 2px solid #000; 
      padding: 2px 4px; 
      font-size: 9px;
    }
    .remarks-label { font-weight: bold; margin-right: 4px; }
    .remarks-value { font-weight: bold; }
    .products-section { 
      border-top: 2px solid #000; 
      padding: 2px 4px; 
      font-size: 9px; 
      line-height: 1.2;
    }
    .products-label { font-weight: bold; margin-right: 4px; }
    .products-value { }
    @media print {
      body { margin: 0; padding: 0; }
      .wrap { padding: 0; max-width: 100%; }
      .label-card { 
        margin-bottom: 2mm; 
        page-break-after: auto;
        height: 93mm;
      }
      .label-card:last-child { page-break-after: auto; }
    }
  </style>
</head>
<body>
  <div id=\"root\" class=\"wrap\">
    ${labelsHtml}
  </div>
</body>
</html>`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(200).send(html);
  } catch (error) {
    next(error);
  }
};

/**
 * Book an integrated order (change from UNBOOKED to BOOKED)
 */
const bookOrder = async (req, res, next) => {
  try {
    const rawId = req.params.id;
    const orderId = Number(rawId);

    if (!Number.isInteger(orderId) || orderId <= 0) {
      return res.status(400).json({ message: 'Invalid order id' });
    }

    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (!order) {
      return res.status(404).json({ message: 'Order not found' });
    }

    if (order.shipperId !== req.user.id) {
      return res.status(403).json({ message: 'Not authorized to book this order' });
    }

    if (!order.isIntegrated || order.bookingState !== 'UNBOOKED') {
      return res.status(400).json({
        message: 'Only unbooked integrated orders can be booked',
      });
    }

    const updated = await prisma.order.update({
      where: { id: orderId },
      data: {
        bookingState: 'BOOKED',
        statusEvents: {
          create: {
            status: order.status,
            note: 'Order booked by shipper',
            createdById: Number(req.user.id) || null,
          },
        },
      },
    });

    res.json(mapOrderToApi(updated));
  } catch (error) {
    next(error);
  }
};

/**
 * CEO Assign Order by QR Scan
 * POST /api/orders/assign-by-scan
 * Auth: CEO/Manager only
 * Body: { bookingId, assignedRiderId }
 */
const assignByScan = async (req, res, next) => {
  try {
    const { bookingId, assignedRiderId } = req.body;
    const assignedByRole = req.user.role;
    const assignedById = Number(req.user.id) || null;

    if (!bookingId || !bookingId.trim()) {
      return res.status(400).json({ message: 'bookingId is required' });
    }

    const riderIdNum = Number(assignedRiderId);
    if (!Number.isInteger(riderIdNum) || riderIdNum <= 0) {
      return res.status(400).json({ message: 'assignedRiderId is required' });
    }

    // Extract bookingId from QR format if present (LLL|bookingId)
    let extractedBookingId = bookingId.trim();
    if (extractedBookingId.includes('|')) {
      const parts = extractedBookingId.split('|');
      if (parts.length === 2 && parts[0] === 'LLL') {
        extractedBookingId = parts[1];
      }
    }

    const order = await prisma.order.findUnique({
      where: { bookingId: extractedBookingId },
      include: {
        shipper: { select: { id: true, name: true, email: true } },
        assignedRider: { select: { id: true, name: true, email: true } },
      },
    });

    if (!order) {
      return res.status(404).json({ message: 'Order not found' });
    }

    const finalStates = ['DELIVERED', 'RETURNED', 'FAILED'];
    if (finalStates.includes(order.status)) {
      return res.status(400).json({
        message: `Cannot assign order. Order is already ${order.status}`,
      });
    }

    const rider = await prisma.user.findUnique({ where: { id: riderIdNum } });
    if (!rider) {
      return res.status(404).json({ message: 'Rider not found' });
    }
    if (rider.role !== 'RIDER') {
      return res.status(400).json({ message: 'User is not a rider' });
    }
    if (rider.status !== 'ACTIVE') {
      return res.status(400).json({ message: 'Rider is not active' });
    }

    const updated = await prisma.order.update({
      where: { id: order.id },
      data: {
        assignedRiderId: riderIdNum,
        status: 'OUT_FOR_DELIVERY',
        outForDeliveryAt: new Date(),
        statusEvents: {
          create: {
            status: 'OUT_FOR_DELIVERY',
            note: `Assigned to rider ${rider.name} by ${assignedByRole} via QR scan`,
            createdById: assignedById,
          },
        },
      },
      include: {
        shipper: { select: { id: true, name: true, email: true } },
        assignedRider: { select: { id: true, name: true, email: true, phone: true } },
      },
    });

    res.json({
      message: `Order assigned to ${rider.name} and marked Out for Delivery`,
      order: mapOrderToApi(updated),
    });
  } catch (error) {
    next(error);
  }
};

const getPendingIntegratedOrdersForShipper = async (req, res, next) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const where = {
      isIntegrated: true,
      bookingState: 'UNBOOKED',
      isDeleted: false,
      shipperApprovalStatus: 'pending',
    };

    // For shipper portal, restrict to the authenticated shipper.
    if (user.role === 'SHIPPER') {
      const shipperIdNum = Number(user.id);
      if (!shipperIdNum || !Number.isInteger(shipperIdNum)) {
        return res.status(401).json({ message: 'Unauthorized' });
      }
      where.shipperId = shipperIdNum;
    }

    // CEO / MANAGER will see all pending integrated orders across shippers.
    const orders = await prisma.order.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: {
        shipper: {
          select: {
            id: true,
            name: true,
            email: true,
            companyName: true,
            phone: true,
          },
        },
      },
    });

    res.json(orders.map(mapOrderToApi));
  } catch (error) {
    next(error);
  }
};

const rejectIntegratedOrder = async (req, res, next) => {
  try {
    const rawId = req.params.id;
    const orderId = Number(rawId);
    const shipperId = req.user.id;

    if (!Number.isInteger(orderId) || orderId <= 0) {
      return res.status(400).json({ message: 'Invalid order id' });
    }

    const order = await prisma.order.findFirst({
      where: {
        id: orderId,
        shipperId,
        isIntegrated: true,
        bookingState: 'UNBOOKED',
        isDeleted: false,
      },
    });

    if (!order) {
      return res
        .status(404)
        .json({ message: 'Order not found or not eligible for rejection' });
    }

    const updated = await prisma.order.update({
      where: { id: orderId },
      data: {
        isDeleted: true,
        shipperApprovalStatus: 'rejected',
        statusEvents: {
          create: {
            status: order.status,
            note: 'Integrated order rejected by shipper',
            createdById: shipperId,
          },
        },
      },
    });

    res.json(mapOrderToApi(updated));
  } catch (error) {
    next(error);
  }
};

/**
 * Get Order Details by Booking ID (Read-only for Riders)
 * GET /api/orders/:bookingId/details
 * Auth: RIDER (assigned) or CEO/Manager
 */
const getOrderDetailsByBookingId = async (req, res, next) => {
  try {
    const { bookingId } = req.params;
    const userId = req.user.id;
    const userRole = req.user.role;

    if (!bookingId || !bookingId.trim()) {
      return res.status(400).json({ message: 'bookingId is required' });
    }

    let extractedBookingId = bookingId.trim();
    if (extractedBookingId.includes('|')) {
      const parts = extractedBookingId.split('|');
      if (parts.length === 2 && parts[0] === 'LLL') {
        extractedBookingId = parts[1];
      }
    }

    const order = await prisma.order.findUnique({
      where: { bookingId: extractedBookingId },
      include: {
        assignedRider: {
          select: { id: true, name: true, email: true, phone: true },
        },
      },
    });

    if (!order) {
      return res.status(404).json({ message: 'Order not found' });
    }

    if (userRole === 'RIDER') {
      if (!order.assignedRiderId || order.assignedRiderId !== userId) {
        return res.status(403).json({
          message: 'You can only view orders assigned to you',
        });
      }
    }

    res.json({
      bookingId: order.bookingId,
      trackingId: order.trackingId,
      consigneeName: order.consigneeName,
      consigneePhone: order.consigneePhone,
      consigneeAddress: order.consigneeAddress,
      destinationCity: order.destinationCity,
      codAmount: order.codAmount,
      status: order.status,
      assignedRider: order.assignedRider
        ? {
            _id: order.assignedRider.id,
            id: order.assignedRider.id,
            name: order.assignedRider.name,
            email: order.assignedRider.email,
            phone: order.assignedRider.phone,
          }
        : null,
      serviceType: order.serviceType,
      paymentType: order.paymentType,
      productDescription: order.productDescription,
      weightKg: order.weightKg,
      serviceCharges: order.serviceCharges,
      createdAt: order.createdAt,
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  createOrder,
  getOrders,
  getManagerOverview,
  getOrderById,
  assignRider,
  updateStatus,
  createFinancialTransaction,
  updateRiderFinance,
  getLabel,
  getLabels,
  printLabelsHtml,
  bookOrder,
  assignByScan,
  getOrderDetailsByBookingId,
  getPendingIntegratedOrdersForShipper,
  rejectIntegratedOrder,
  ceoEditOrder,
};
