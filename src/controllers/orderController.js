const Order = require('../models/Order');
const CommissionConfig = require('../models/CommissionConfig');
const FinancialTransaction = require('../models/FinancialTransaction');
const RiderProfile = require('../models/RiderProfile');
const generateBookingId = require('../config/bookingId');
const generateTrackingId = require('../config/trackingId');
const QRCode = require('qrcode');

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

    if (!weightKg || weightKg <= 0) {
      return res.status(400).json({ message: 'weightKg required and must be > 0' });
    }

    const bookingId = await generateBookingId();
    const trackingId = await generateTrackingId();
    const shipperIdToUse = (process.env.DEFAULT_SHIPPER_ID && process.env.DEFAULT_SHIPPER_ID.length >= 10)
      ? process.env.DEFAULT_SHIPPER_ID
      : req.user.id;

    // Commission Config/weight-based logic
    let serviceCharges = 0;
    const commissionConfig = await CommissionConfig.findOne({ shipper: shipperIdToUse });
    if (!commissionConfig || !Array.isArray(commissionConfig.weightBrackets) || commissionConfig.weightBrackets.length === 0) {
      return res.status(400).json({ message: 'No commission weight brackets configured for this shipper' });
    }
    // Find weight bracket
    const bracketsSorted = commissionConfig.weightBrackets.slice().sort((a,b)=>a.minKg-b.minKg);
    const matching = bracketsSorted.find(b => (weightKg >= b.minKg) && (b.maxKg === null || typeof b.maxKg==='undefined' || weightKg < b.maxKg));
    if (!matching) {
      return res.status(400).json({ message: 'No weight bracket matched for this shipper' });
    }
    serviceCharges = matching.charge;

    const orderData = {
      bookingId,
      trackingId,
      shipper: shipperIdToUse,
      consigneeName,
      consigneePhone,
      consigneeAddress,
      destinationCity,
      serviceType,
      paymentType: paymentType || (Number(codAmount) > 0 ? 'COD' : 'ADVANCE'),
      codAmount: paymentType === 'ADVANCE' ? 0 : Number(codAmount || 0),
      productDescription,
      pieces,
      fragile,
      weightKg: Number(weightKg),
      serviceCharges,
      totalAmount: (paymentType === 'ADVANCE' ? 0 : Number(codAmount || 0)) + serviceCharges,
      remarks,
      status: 'CREATED',
      statusHistory: [{
        status: 'CREATED', updatedBy: req.user.id, note: 'Order created by shipper'
      }],
      isIntegrated: false,
      bookingState: 'BOOKED'
    };

    const order = new Order(orderData);
    const savedOrder = await order.save();
    res.status(201).json(savedOrder);
  } catch (err) {
    next(err);
  }
};

const getOrders = async (req, res, next) => {
  try {
    const { role, id } = req.user;
    const { status, from, to, q } = req.query;

    let query = {};

    if (role === 'SHIPPER') {
      query.shipper = id;
    } else if (role === 'RIDER') {
      query.assignedRider = id;
      query.bookingState = 'BOOKED';
    } else if (['CEO', 'MANAGER'].includes(role)) {
      query.$or = [
        { isIntegrated: { $ne: true } },
        { isIntegrated: true, bookingState: 'BOOKED' }
      ];
    }

    if (status) {
      query.status = status;
    }

    if (from || to) {
      query.createdAt = {};
      if (from) query.createdAt.$gte = new Date(from);
      if (to) query.createdAt.$lte = new Date(to);
    }

    if (q && q.trim()) {
      const searchId = q.trim();
      query.$or = [
        { bookingId: searchId },
        { trackingId: searchId }
      ];
    }

    const orders = await Order.find(query)
      .populate('shipper', 'name email companyName')
      .populate('assignedRider', 'name phone')
      .sort({ createdAt: -1 });

    res.json(orders);
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
      $or: [
        { isIntegrated: { $ne: true } },
        { isIntegrated: true, bookingState: 'BOOKED' }
      ]
    };

    const todayFilter = { createdAt: { $gte: start, $lte: end }, ...visibility };

    const todayReceived = await Order.countDocuments(todayFilter);
    const todayBooked = await Order.countDocuments({ ...todayFilter, assignedRider: { $ne: null } });
    const todayUnbooked = await Order.countDocuments({ ...todayFilter, assignedRider: null });

    const warehouseCount = await Order.countDocuments({ status: 'ASSIGNED', ...visibility });
    const outForDeliveryCount = await Order.countDocuments({ status: 'OUT_FOR_DELIVERY', ...visibility });
    const returnedCount = await Order.countDocuments({ status: 'RETURNED', ...visibility });

    const pendingReviewCountAgg = await FinancialTransaction.countDocuments({ settlementStatus: 'PENDING' });

    res.json({
      todayReceived,
      todayBooked,
      todayUnbooked,
      warehouseCount,
      outForDeliveryCount,
      returnedCount,
      deliveryUnderReviewCount: pendingReviewCountAgg
    });
  } catch (error) {
    next(error);
  }
};

const getOrderById = async (req, res, next) => {
  try {
    const { id } = req.params;
    const order = await Order.findById(id)
      .populate('shipper', 'name email')
      .populate('assignedRider', 'name phone');
    if (!order) return res.status(404).json({ message: 'Order not found' });

    const userId = req.user.id;
    const role = req.user.role;
    if (role === 'SHIPPER' && order.shipper._id.toString() !== userId) {
      return res.status(403).json({ message: 'Forbidden' });
    }
    const assignedId = typeof order.assignedRider === 'object' && order.assignedRider !== null
      ? order.assignedRider._id?.toString()
      : order.assignedRider?.toString();
    if (role === 'RIDER' && assignedId !== userId) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    res.json(order);
  } catch (error) {
    next(error);
  }
};

const assignRider = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { riderId } = req.body;

    const order = await Order.findById(id);
    if (!order) {
      return res.status(404).json({ message: 'Order not found' });
    }

    const previousRider = order.assignedRider;
    order.assignedRider = riderId || null;

    if (riderId && order.status === 'CREATED') {
      order.status = 'ASSIGNED';
    }

    order.statusHistory.push({
      status: order.status,
      updatedBy: req.user.id,
      note: riderId
        ? `Assigned to rider ${riderId}`
        : `Unassigned from rider ${previousRider}`
    });

    await order.save();

    const updatedOrder = await Order.findById(id)
      .populate('shipper', 'name')
      .populate('assignedRider', 'name');

    res.json(updatedOrder);
  } catch (error) {
    next(error);
  }
};

const createFinancialTransaction = async (order) => {
  try {
    const existing = await FinancialTransaction.findOne({ order: order._id });

    const isDelivered = order.status === 'DELIVERED';
    const cod = isDelivered ? (order.amountCollected || order.codAmount || 0) : 0;

    const config = await CommissionConfig.findOne({ shipper: order.shipper });
    let companyCommission = 0;
    if (isDelivered && config) {
      if (config.type === 'PERCENTAGE') {
        companyCommission = (cod * config.value) / 100;
      } else {
        companyCommission = config.value;
      }
    }

    let riderCommission = 0;
    if (order.assignedRider) {
      const riderCfgModel = require('../models/RiderCommissionConfig');
      const riderCfg = await riderCfgModel.findOne({ rider: order.assignedRider });
      if (riderCfg) {
        let rule;
        if (Array.isArray(riderCfg.rules) && riderCfg.rules.length) {
          rule = riderCfg.rules.find(r => r.status === order.status);
        }
        if (rule) {
          if (rule.type === 'PERCENTAGE') {
            riderCommission = (cod * rule.value) / 100;
          } else {
            riderCommission = rule.value;
          }
        } else if (riderCfg.type && riderCfg.value !== undefined) {
          if (riderCfg.type === 'PERCENTAGE') {
            riderCommission = (cod * riderCfg.value) / 100;
          } else {
            riderCommission = riderCfg.value;
          }
        }
      }
    }

    companyCommission = Math.min(companyCommission, cod);
    riderCommission = Math.min(riderCommission, cod);
    const shipperShare = cod - companyCommission;

    const payload = {
      order: order._id,
      shipper: order.shipper,
      rider: order.assignedRider,
      totalCodCollected: cod,
      shipperShare: shipperShare,
      companyCommission: companyCommission,
      riderCommission: riderCommission,
      settlementStatus: 'PENDING'
    };

    if (existing) {
      await FinancialTransaction.updateOne({ _id: existing._id }, payload);
    } else {
      await FinancialTransaction.create(payload);
    }
  } catch (err) {
    console.error('Error creating financial transaction:', err);
  }
};

const updateRiderFinance = async (order) => {
  try {
    if (!order.assignedRider) return;

    const riderProfile = await RiderProfile.findOne({ user: order.assignedRider });
    if (!riderProfile) {
      await RiderProfile.create({
        user: order.assignedRider,
        codCollected: order.amountCollected || order.codAmount || 0,
        serviceCharges: order.serviceCharges || 0,
        serviceChargeStatus: 'unpaid'
      });
      return;
    }

    if (riderProfile.serviceChargeStatus === 'unpaid') {
      riderProfile.codCollected += (order.amountCollected || order.codAmount || 0);
      riderProfile.serviceCharges += (order.serviceCharges || 0);
      await riderProfile.save();
    } else {
      riderProfile.codCollected += (order.amountCollected || order.codAmount || 0);
      await riderProfile.save();
    }
  } catch (err) {
    console.error('Error updating rider finance:', err);
  }
};

const updateStatus = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { status, amountCollected, reason } = req.body;

    const order = await Order.findById(id);
    if (!order) {
      return res.status(404).json({ message: 'Order not found' });
    }

    // Restrict RIDER: can only update status for orders assigned to them
    if (req.user.role === 'RIDER') {
      const assignedRiderId = order.assignedRider 
        ? (order.assignedRider._id ? order.assignedRider._id.toString() : order.assignedRider.toString())
        : null;
      const riderId = req.user.id || req.user._id;
      
      if (!assignedRiderId || assignedRiderId !== riderId.toString()) {
        return res.status(403).json({ 
          message: 'You can only update status for orders assigned to you' 
        });
      }
    }

    const validStatuses = [
      'OUT_FOR_DELIVERY',
      'DELIVERED',
      'RETURNED',
      'FAILED',
      'FIRST_ATTEMPT',
      'SECOND_ATTEMPT',
      'THIRD_ATTEMPT'
    ];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ message: 'Invalid status for update' });
    }

    const previousStatus = order.status;
    order.status = status;

    if (status === 'DELIVERED') {
      order.deliveredAt = Date.now();
      const parsed = Number(amountCollected);
      if (!isNaN(parsed) && parsed >= 0) {
        order.amountCollected = parsed;
      } else {
        order.amountCollected = order.codAmount;
      }
    } else if (status === 'FAILED' || status === 'RETURNED') {
      order.failedReason = reason;
    }

    order.statusHistory.push({
      status: status,
      updatedBy: req.user.id,
      note: reason || `Status updated to ${status}`
    });

    await order.save();

    if (['DELIVERED', 'RETURNED', 'FAILED'].includes(status) && previousStatus !== status) {
      await createFinancialTransaction(order);

      if (order.assignedRider && status === 'DELIVERED') {
        await updateRiderFinance(order);
      }
    }

    res.json(order);
  } catch (error) {
    next(error);
  }
};

const getLabel = async (req, res, next) => {
  try {
    const { id } = req.params;

    const order = await Order.findById(id).populate('shipper', 'name companyName');

    if (!order) {
      return res.status(404).json({ message: 'Order not found' });
    }

    const userId = req.user.id;
    const role = req.user.role;

    if (role === 'SHIPPER' && order.shipper._id.toString() !== userId) {
      return res.status(403).json({ message: 'Forbidden' });
    }
    if (role === 'RIDER' && order.assignedRider?.toString() !== userId) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    const labelData = {
      bookingId: order.bookingId,
      trackingId: order.trackingId,
      consignee: {
        name: order.consigneeName,
        phone: order.consigneePhone,
        address: order.consigneeAddress,
        destinationCity: order.destinationCity
      },
      shipper: {
        name: order.shipper.name,
        companyName: order.shipper.companyName || 'N/A',
        serviceType: order.serviceType
      },
      order: {
        codAmount: order.codAmount,
        serviceCharges: order.serviceCharges || 0,
        paymentType: order.paymentType,
        productDescription: order.productDescription,
        pieces: order.pieces,
        fragile: order.fragile,
        createdAt: order.createdAt
      }
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
    const idList = ids.split(',').map(s => s.trim()).filter(Boolean);
    if (idList.length === 0) return res.status(400).json({ message: 'No ids provided' });

    const orders = await Order.find({ _id: { $in: idList } }).populate('shipper', 'name companyName').lean();
    if (!orders || orders.length === 0) return res.status(404).json({ message: 'Orders not found' });

    const userId = req.user.id;
    const role = req.user.role;
    const permitted = orders.filter(order => {
      if (role === 'SHIPPER') return order.shipper && String(order.shipper._id || order.shipper) === userId;
      if (role === 'RIDER') return String(order.assignedRider || '') === userId;
      return true;
    });

    const labels = permitted.map(order => ({
      bookingId: order.bookingId,
      trackingId: order.trackingId,
      consignee: {
        name: order.consigneeName,
        phone: order.consigneePhone,
        address: order.consigneeAddress,
        destinationCity: order.destinationCity
      },
      shipper: {
        name: order.shipper?.name || 'N/A',
        companyName: order.shipper?.companyName || 'N/A',
        serviceType: order.serviceType
      },
      order: {
        codAmount: order.codAmount,
        serviceCharges: order.serviceCharges || 0,
        paymentType: order.paymentType,
        productDescription: order.productDescription,
        pieces: order.pieces,
        fragile: order.fragile,
        createdAt: order.createdAt
      }
    }));

    res.json({ count: labels.length, labels });
  } catch (error) {
    next(error);
  }
};

const printLabelsHtml = async (req, res, next) => {
  try {
    const shipperId = req.user.id;
    const ids = Array.isArray(req.body.orderIds) ? req.body.orderIds : [];
    if (!ids.length) return res.status(400).send('No orderIds provided');

    const orders = await Order.find({ _id: { $in: ids }, shipper: shipperId })
      .populate('shipper', 'name companyName')
      .lean();
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
      const codAmount = Number(o.codAmount || 0);
      const serviceCharges = Number(o.serviceCharges || 0);
      const finalAmount = codAmount + serviceCharges;
      const cod = Number(finalAmount || 0).toLocaleString();
      const created = new Date(o.createdAt).toISOString().split('T')[0];
      const trackingBarcode = barcodeSvg(String(o.trackingId || '').replace(/[^0-9]/g, ''));
      const orderBarcode = barcodeSvg(String(o.bookingId || '').replace(/[^0-9]/g, ''));
      const codBarcode = barcodeSvg(String(finalAmount).replace(/[^0-9]/g, ''));
      const shipperName = o.shipper?.name || 'N/A';
      const shipperAddress = o.shipper?.address || o.shipper?.companyName || 'N/A';
      const shipperPhone = o.shipper?.phone || 'N/A';
      const service = o.paymentType || o.serviceType || 'COD';
      const weightVal = o.weight || '0.5 KG';
      const fragileVal = o.fragile ? 'true' : 'false';
      const piecesVal = o.pieces || 1;
      const remarksVal = o.remarks || (o.fragile ? 'FRAGILE - Handle with care' : 'Allow to open in front of rider');
      const products = o.productDescription || 'N/A';
      const qrContent = `LLL|${o.bookingId || ''}`;
      const qrDataUrl = await QRCode.toDataURL(qrContent, { margin: 0, width: 90 });
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
                  <span class=\"order-label\">Order: ${o.bookingId}</span>
                  <div class=\"barcode-container\">${orderBarcode}</div>
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
                  <img src=\"${qrDataUrl}\" alt=\"QR ${qrContent}\" class=\"qr-img\" />
                  <div class=\"qr-caption\">Scan to mark<br/>arrived at LLL warehouse</div>
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
          <span class=\"remarks-value\">- ${remarksVal}</span>
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
    const { id } = req.params;
    const order = await Order.findById(id);
    if (!order) {
      return res.status(404).json({ message: 'Order not found' });
    }
    if (order.shipper.toString() !== req.user.id) {
      return res.status(403).json({ message: 'Not authorized to book this order' });
    }
    if (!order.isIntegrated || order.bookingState !== 'UNBOOKED') {
      return res.status(400).json({ 
        message: 'Only unbooked integrated orders can be booked' 
      });
    }
    
    order.bookingState = 'BOOKED';
    order.statusHistory.push({
      status: order.status,
      updatedBy: req.user.id,
      note: 'Order booked by shipper'
    });
    
    const updatedOrder = await order.save();
    res.json(updatedOrder);
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
    const assignedBy = req.user.id || req.user._id;
    const assignedByRole = req.user.role;

    if (!bookingId || !bookingId.trim()) {
      return res.status(400).json({ message: 'bookingId is required' });
    }

    if (!assignedRiderId) {
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

    // Find order
    const order = await Order.findOne({ bookingId: extractedBookingId })
      .populate('shipper', 'name email')
      .populate('assignedRider', 'name email');

    if (!order) {
      return res.status(404).json({ message: 'Order not found' });
    }

    // Validate order is eligible for assignment
    const finalStates = ['DELIVERED', 'RETURNED', 'FAILED'];
    if (finalStates.includes(order.status)) {
      return res.status(400).json({ 
        message: `Cannot assign order. Order is already ${order.status}` 
      });
    }

    // Validate rider exists and is a RIDER
    const User = require('../models/User');
    const rider = await User.findById(assignedRiderId);
    if (!rider) {
      return res.status(404).json({ message: 'Rider not found' });
    }
    if (rider.role !== 'RIDER') {
      return res.status(400).json({ message: 'User is not a rider' });
    }
    if (rider.status !== 'ACTIVE') {
      return res.status(400).json({ message: 'Rider is not active' });
    }

    // Assign order to rider
    const previousRider = order.assignedRider;
    order.assignedRider = assignedRiderId;
    order.status = 'OUT_FOR_DELIVERY';
    order.outForDeliveryAt = new Date();
    
    // Add status history entry
    order.statusHistory.push({
      status: 'OUT_FOR_DELIVERY',
      timestamp: new Date(),
      updatedBy: assignedBy,
      note: `Assigned to rider ${rider.name} by ${assignedByRole} via QR scan`
    });

    const updatedOrder = await order.save();

    res.json({
      message: `Order assigned to ${rider.name} and marked Out for Delivery`,
      order: updatedOrder
    });
  } catch (error) {
    next(error);
  }
};

const getPendingIntegratedOrdersForShipper = async (req, res, next) => {
  try {
    const shipperId = req.user.id || req.user._id;
    if (!shipperId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const orders = await Order.find({
      shipper: shipperId,
      isIntegrated: true,
      bookingState: 'UNBOOKED',
      isDeleted: { $ne: true },
      shipperApprovalStatus: 'pending',
    })
      .sort({ createdAt: -1 });

    res.json(orders);
  } catch (error) {
    next(error);
  }
};

const rejectIntegratedOrder = async (req, res, next) => {
  try {
    const { id } = req.params;
    const shipperId = req.user.id || req.user._id;

    const order = await Order.findOne({
      _id: id,
      shipper: shipperId,
      isIntegrated: true,
      bookingState: 'UNBOOKED',
      isDeleted: { $ne: true },
    });

    if (!order) {
      return res.status(404).json({ message: 'Order not found or not eligible for rejection' });
    }

    order.isDeleted = true;
    order.shipperApprovalStatus = 'rejected';
    order.statusHistory.push({
      status: order.status,
      updatedBy: shipperId,
      note: 'Integrated order rejected by shipper',
    });

    const updated = await order.save();

    res.json(updated);
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
    const userId = req.user.id || req.user._id;
    const userRole = req.user.role;

    if (!bookingId || !bookingId.trim()) {
      return res.status(400).json({ message: 'bookingId is required' });
    }

    // Extract bookingId from QR format if present
    let extractedBookingId = bookingId.trim();
    if (extractedBookingId.includes('|')) {
      const parts = extractedBookingId.split('|');
      if (parts.length === 2 && parts[0] === 'LLL') {
        extractedBookingId = parts[1];
      }
    }

    // Find order
    const order = await Order.findOne({ bookingId: extractedBookingId })
      .populate('shipper', 'name email')
      .populate('assignedRider', 'name email phone');

    if (!order) {
      return res.status(404).json({ message: 'Order not found' });
    }

    // RIDER can only view orders assigned to them
    if (userRole === 'RIDER') {
      const assignedRiderId = order.assignedRider 
        ? (order.assignedRider._id ? order.assignedRider._id.toString() : order.assignedRider.toString())
        : null;
      
      if (!assignedRiderId || assignedRiderId !== userId.toString()) {
        return res.status(403).json({ 
          message: 'You can only view orders assigned to you' 
        });
      }
    }

    // Return order details (read-only, no sensitive data)
    res.json({
      bookingId: order.bookingId,
      trackingId: order.trackingId,
      consigneeName: order.consigneeName,
      consigneePhone: order.consigneePhone,
      consigneeAddress: order.consigneeAddress,
      destinationCity: order.destinationCity,
      codAmount: order.codAmount,
      status: order.status,
      assignedRider: order.assignedRider ? {
        _id: order.assignedRider._id || order.assignedRider,
        name: order.assignedRider.name,
        email: order.assignedRider.email,
        phone: order.assignedRider.phone
      } : null,
      serviceType: order.serviceType,
      paymentType: order.paymentType,
      productDescription: order.productDescription,
      weightKg: order.weightKg,
      serviceCharges: order.serviceCharges,
      createdAt: order.createdAt
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
  rejectIntegratedOrder
};
