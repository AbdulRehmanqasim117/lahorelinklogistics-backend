const ExcelJS = require("exceljs");
const prisma = require("../prismaClient");

// Basic date parsing helper that understands HTML date inputs (YYYY-MM-DD)
// and falls back to native Date parsing. Returns null if invalid.
const parseDateInput = (raw) => {
  if (!raw) return null;
  const value = String(raw).trim();
  if (!value) return null;

  // HTML date input: YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [y, m, d] = value.split("-").map((v) => parseInt(v, 10));
    const dt = new Date(y, m - 1, d);
    return Number.isNaN(dt.getTime()) ? null : dt;
  }

  const dt = new Date(value);
  return Number.isNaN(dt.getTime()) ? null : dt;
};

// Helper function to calculate service charges if missing
const calculateServiceCharges = async (order) => {
  const existing = Number(order.serviceCharges || 0);
  if (existing > 0) {
    return existing;
  }

  try {
    const shipperId =
      order.shipperId || order.shipper?.id || order.shipper?.shipperId || null;
    const weightKg = Number(order.weightKg || 0);

    if (!shipperId || !weightKg) {
      return 0;
    }

    const cfg = await prisma.commissionConfig.findUnique({
      where: { shipperId: Number(shipperId) },
      include: { weightBrackets: true },
    });

    if (!cfg || !Array.isArray(cfg.weightBrackets) || cfg.weightBrackets.length === 0) {
      return 0;
    }

    const bracketsSorted = cfg.weightBrackets
      .slice()
      .sort((a, b) => Number(a.minKg || 0) - Number(b.minKg || 0));

    const matching = bracketsSorted.find((b) => {
      const min = Number(b.minKg || 0);
      const max = b.maxKg === null || typeof b.maxKg === "undefined"
        ? null
        : Number(b.maxKg);
      const withinMin = weightKg >= min;
      const withinMax = max === null ? true : weightKg < max;
      return withinMin && withinMax;
    });

    return matching ? Number(matching.chargePkr || 0) : 0;
  } catch (error) {
    console.error("Error calculating service charges:", error);
    return 0;
  }
};

const formatInvoiceNumber = (seq) => {
  const safeSeq = Number(seq || 0);
  return `A${safeSeq.toString().padStart(5, "0")}`;
};

const getNextInvoiceNumberPreviewInternal = async () => {
  const counter = await prisma.counter.findUnique({
    where: { key: "PAYMENT_INVOICE" },
  });

  if (counter) {
    return formatInvoiceNumber(counter.seq + 1);
  }

  const latest = await prisma.invoice.findFirst({
    where: { invoiceNumber: { startsWith: "A" } },
    orderBy: { invoiceNumber: "desc" },
    select: { invoiceNumber: true },
  });

  const latestSeq = latest?.invoiceNumber
    ? Number(String(latest.invoiceNumber).slice(1)) || 0
    : 0;

  return formatInvoiceNumber(latestSeq + 1);
};

const allocateNextInvoiceNumber = async (tx) => {
  const counter = await tx.counter.upsert({
    where: { key: "PAYMENT_INVOICE" },
    update: { seq: { increment: 1 } },
    create: { key: "PAYMENT_INVOICE", seq: 1 },
  });

  return formatInvoiceNumber(counter.seq);
};

const mapShipperForInvoice = (user) => {
  if (!user) return null;
  return {
    _id: String(user.id),
    id: user.id,
    name: user.name,
    email: user.email,
    companyName: user.companyName || null,
    phone: user.phone || user.contactNumber || null,
    address: user.pickupAddress || null,
    bankName: user.bankName || null,
    accountType: user.accountType || null,
    accountHolderName: user.accountHolderName || null,
    accountNumber: user.accountNumber || null,
    iban: user.iban || null,
  };
};

const mapOrderForInvoiceList = (order, serviceCharges) => {
  const codAmount = Number(order.codAmount || 0);
  const svc = Number(order.serviceCharges || serviceCharges || 0);

  return {
    _id: String(order.id),
    id: order.id,
    bookingId: order.bookingId,
    trackingId: order.trackingId,
    consigneeName: order.consigneeName,
    destinationCity: order.destinationCity,
    weightKg: Number(order.weightKg || 0),
    codAmount,
    serviceCharges: svc,
    status: order.status,
    createdAt: order.createdAt,
    shipper: mapShipperForInvoice(order.shipper),
    invoice: order.invoice
      ? {
          _id: order.invoice.id,
          id: order.invoice.id,
          invoiceNumber: order.invoice.invoiceNumber,
        }
      : null,
  };
};

const mapInvoiceOrder = (order) => ({
  _id: order.id,
  id: order.id,
  bookingId: order.bookingId,
  trackingId: order.trackingId,
  createdAt: order.createdAt,
  consigneeName: order.consigneeName,
  destinationCity: order.destinationCity,
  weightKg: Number(order.weightKg || 0),
  codAmount: Number(order.codAmount || 0),
  serviceCharges: Number(order.serviceCharges || 0),
  status: order.status,
});

const mapInvoice = (invoice) => ({
  _id: invoice.id,
  id: invoice.id,
  invoiceNumber: invoice.invoiceNumber,
  shipper: mapShipperForInvoice(invoice.shipper),
  accountName: invoice.accountName,
  accountNumber: invoice.accountNumber || "",
  invoiceDate: invoice.invoiceDate,
  parcelFrom: invoice.parcelFrom,
  parcelTo: invoice.parcelTo,
  codTotal: Number(invoice.codTotal || 0),
  flyerChargesTotal: Number(invoice.flyerChargesTotal || invoice.serviceChargesTotal || 0),
  serviceChargesTotal: Number(invoice.serviceChargesTotal || 0),
  fuelCharges: Number(invoice.fuelCharges || 0),
  otherCharges: Number(invoice.otherCharges || 0),
  discount: Number(invoice.discount || 0),
  whtIt: Number(invoice.whtIt || 0),
  whtSt: Number(invoice.whtSt || 0),
  netPayable: Number(invoice.netPayable || 0),
  createdBy: invoice.createdBy
    ? { _id: invoice.createdBy.id, id: invoice.createdBy.id, name: invoice.createdBy.name }
    : null,
  status: invoice.status,
  orders: invoice.orders ? invoice.orders.map(mapInvoiceOrder) : [],
});

// Get orders for invoice (with filters)
exports.getOrdersForInvoice = async (req, res, next) => {
  try {
    const { shipperId, from, to, list = "all" } = req.query;

    if (!shipperId) {
      return res.status(400).json({ message: "Shipper ID is required" });
    }

    const shipperIdNum = Number(shipperId);
    if (!Number.isInteger(shipperIdNum) || shipperIdNum <= 0) {
      return res.status(400).json({ message: "Invalid shipper id" });
    }

    const where = {
      shipperId: shipperIdNum,
      bookingState: "BOOKED",
      isDeleted: false,
    };

    if (from && to) {
      const fromDate = new Date(from);
      const toDate = new Date(to);

      fromDate.setHours(0, 0, 0, 0);
      toDate.setHours(23, 59, 59, 999);

      if (!Number.isNaN(fromDate.getTime()) && !Number.isNaN(toDate.getTime())) {
        where.createdAt = {
          gte: fromDate,
          lte: toDate,
        };
      }
    }

    if (list === "invoiced") {
      where.invoiceId = { not: null };
    } else if (list === "uninvoiced") {
      where.invoiceId = null;
    }

    const orders = await prisma.order.findMany({
      where,
      include: {
        shipper: true,
        invoice: {
          select: {
            id: true,
            invoiceNumber: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    const ordersWithCharges = await Promise.all(
      orders.map(async (order) => {
        const svc = await calculateServiceCharges(order);
        return mapOrderForInvoiceList(order, svc);
      }),
    );

    res.json(ordersWithCharges);
  } catch (error) {
    next(error);
  }
};

// Create new invoice
exports.createInvoice = async (req, res, next) => {
  try {
    const {
      shipperId,
      accountName,
      accountNumber,
      invoiceDate,
      parcelFrom,
      parcelTo,
      selectedOrderIds,
      whtIt = 0,
      whtSt = 0,
    } = req.body;

    if (
      !shipperId ||
      !accountName ||
      !selectedOrderIds ||
      !Array.isArray(selectedOrderIds) ||
      selectedOrderIds.length === 0
    ) {
      return res.status(400).json({
        message:
          "Missing required fields: shipperId, accountName, and selectedOrderIds",
      });
    }

    const shipperIdNum = Number(shipperId);
    if (!Number.isInteger(shipperIdNum) || shipperIdNum <= 0) {
      return res.status(400).json({ message: "Invalid shipper id" });
    }

    const orderIds = selectedOrderIds
      .map((id) => Number(id))
      .filter((id) => Number.isInteger(id) && id > 0);

    if (orderIds.length === 0) {
      return res.status(400).json({ message: "No valid orders selected" });
    }

    const orders = await prisma.order.findMany({
      where: {
        id: { in: orderIds },
        shipperId: shipperIdNum,
        invoiceId: null,
        isDeleted: false,
      },
    });

    if (!orders.length) {
      return res
        .status(400)
        .json({ message: "No valid uninvoiced orders found" });
    }

    if (orders.length !== orderIds.length) {
      return res.status(400).json({
        message:
          "Some orders are already invoiced or do not belong to this shipper",
      });
    }

    let codTotal = 0;
    let serviceChargesTotal = 0;

    // Also collect min/max dates from selected orders to use as a
    // sensible default invoice period if parcelFrom/parcelTo are
    // missing or invalid from the client.
    let minOrderDate = null;
    let maxOrderDate = null;

    for (const order of orders) {
      codTotal += Number(order.codAmount || 0);
      const svc = await calculateServiceCharges(order);
      serviceChargesTotal += svc;

      const baseDate = order.deliveredAt || order.createdAt;
      if (baseDate instanceof Date && !Number.isNaN(baseDate.getTime())) {
        if (!minOrderDate || baseDate < minOrderDate) minOrderDate = baseDate;
        if (!maxOrderDate || baseDate > maxOrderDate) maxOrderDate = baseDate;
      }
    }

    const numericWhtIt = Number(whtIt) || 0;
    const numericWhtSt = Number(whtSt) || 0;

    const netPayable =
      codTotal + serviceChargesTotal - numericWhtIt - numericWhtSt;

    const creatorRawId = req.user && (req.user.id || req.user._id);
    const creatorId = Number(creatorRawId);
    if (!Number.isInteger(creatorId) || creatorId <= 0) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    // Parse invoice and period dates safely
    const invoiceDateObj = parseDateInput(invoiceDate) || new Date();
    let parcelFromDate = parseDateInput(parcelFrom);
    let parcelToDate = parseDateInput(parcelTo);

    if (!parcelFromDate || !parcelToDate) {
      if (minOrderDate && !parcelFromDate) parcelFromDate = new Date(minOrderDate);
      if (maxOrderDate && !parcelToDate) parcelToDate = new Date(maxOrderDate);
    }

    // Final fallbacks: never let invalid Date objects through to Prisma
    if (!parcelFromDate) parcelFromDate = new Date(invoiceDateObj);
    if (!parcelToDate) parcelToDate = new Date(invoiceDateObj);

    const createdInvoice = await prisma.$transaction(async (tx) => {
      const invoiceNumber = await allocateNextInvoiceNumber(tx);

      const invoice = await tx.invoice.create({
        data: {
          invoiceNumber,
          shipperId: shipperIdNum,
          accountName,
          accountNumber: accountNumber || "",
          invoiceDate: invoiceDateObj,
          parcelFrom: parcelFromDate,
          parcelTo: parcelToDate,
          codTotal,
          flyerChargesTotal: serviceChargesTotal,
          serviceChargesTotal,
          whtIt: numericWhtIt,
          whtSt: numericWhtSt,
          netPayable,
          createdById: creatorId,
        },
      });

      await tx.order.updateMany({
        where: { id: { in: orderIds } },
        data: {
          invoiceId: invoice.id,
          invoicedAt: new Date(),
        },
      });

      const fullInvoice = await tx.invoice.findUnique({
        where: { id: invoice.id },
        include: {
          shipper: true,
          orders: true,
          createdBy: {
            select: { id: true, name: true },
          },
        },
      });

      return fullInvoice;
    });

    res.status(201).json({
      message: "Invoice created successfully",
      invoice: mapInvoice(createdInvoice),
    });
  } catch (error) {
    next(error);
  }
};

// Get invoice by ID
exports.getInvoice = async (req, res, next) => {
  try {
    const { id } = req.params;
    const invoiceId = Number(id);
    if (!Number.isInteger(invoiceId) || invoiceId <= 0) {
      return res.status(400).json({ message: "Invalid invoice id" });
    }

    const invoice = await prisma.invoice.findUnique({
      where: { id: invoiceId },
      include: {
        shipper: true,
        orders: true,
        createdBy: {
          select: { id: true, name: true },
        },
      },
    });

    if (!invoice) {
      return res.status(404).json({ message: "Invoice not found" });
    }

    res.json(mapInvoice(invoice));
  } catch (error) {
    next(error);
  }
};

// Get invoice list
exports.getInvoices = async (req, res, next) => {
  try {
    const { shipperId, from, to, page = 1, limit = 20 } = req.query;

    const where = {};

    if (shipperId) {
      const sid = Number(shipperId);
      if (Number.isInteger(sid) && sid > 0) {
        where.shipperId = sid;
      }
    }

    if (from && to) {
      const fromDate = new Date(from);
      const toDate = new Date(to);
      if (!Number.isNaN(fromDate.getTime()) && !Number.isNaN(toDate.getTime())) {
        where.invoiceDate = {
          gte: fromDate,
          lte: toDate,
        };
      }
    }

    const pageNum = Math.max(1, Number(page) || 1);
    const limitNum = Math.min(100, Math.max(1, Number(limit) || 20));

    const [total, invoices] = await Promise.all([
      prisma.invoice.count({ where }),
      prisma.invoice.findMany({
        where,
        include: {
          shipper: true,
          createdBy: { select: { id: true, name: true } },
        },
        orderBy: { createdAt: "desc" },
        skip: (pageNum - 1) * limitNum,
        take: limitNum,
      }),
    ]);

    res.json({
      invoices: invoices.map(mapInvoice),
      totalPages: Math.ceil(total / limitNum) || 0,
      currentPage: pageNum,
      total,
    });
  } catch (error) {
    next(error);
  }
};

// Get next invoice number (for preview)
exports.getNextInvoiceNumber = async (req, res, next) => {
  try {
    const invoiceNumber = await getNextInvoiceNumberPreviewInternal();
    res.json({ invoiceNumber });
  } catch (error) {
    next(error);
  }
};

// Get all shippers for dropdown
exports.getShippers = async (req, res, next) => {
  try {
    const shippers = await prisma.user.findMany({
      where: { role: "SHIPPER" },
      orderBy: { name: "asc" },
    });

    res.json(shippers.map(mapShipperForInvoice));
  } catch (error) {
    next(error);
  }
};

// Export invoice to Excel
exports.exportInvoiceToExcel = async (req, res, next) => {
  try {
    const { id } = req.params;
    const invoiceId = Number(id);
    if (!Number.isInteger(invoiceId) || invoiceId <= 0) {
      return res.status(400).json({ message: "Invalid invoice id" });
    }

    const invoice = await prisma.invoice.findUnique({
      where: { id: invoiceId },
      include: {
        shipper: true,
        orders: true,
        createdBy: { select: { id: true, name: true } },
      },
    });

    if (!invoice) {
      return res.status(404).json({ message: "Invoice not found" });
    }

    // Create a new workbook and worksheet
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("Invoice");

    // Set column widths
    worksheet.columns = [
      { key: "cn", width: 15 },
      { key: "date", width: 12 },
      { key: "consignee", width: 20 },
      { key: "destination", width: 15 },
      { key: "weight", width: 10 },
      { key: "cod", width: 12 },
      { key: "charges", width: 12 },
      { key: "status", width: 15 },
    ];

    // Add header section
    worksheet.mergeCells("A1:H1");
    worksheet.getCell("A1").value = "LAHORELINK LOGISTICS";
    worksheet.getCell("A1").font = { bold: true, size: 18 };
    worksheet.getCell("A1").alignment = { horizontal: "center" };

    // Invoice details
    worksheet.getCell("A3").value = "Invoice No:";
    worksheet.getCell("B3").value = invoice.invoiceNumber;
    worksheet.getCell("A4").value = "Invoice Date:";
    worksheet.getCell("B4").value = invoice.invoiceDate.toDateString();

    worksheet.getCell("F3").value = "Customer:";
    worksheet.getCell("G3").value =
      invoice.shipper.companyName || invoice.shipper.name;
    worksheet.getCell("F4").value = "Account Name:";
    worksheet.getCell("G4").value = invoice.accountName;
    worksheet.getCell("F5").value = "Account No:";
    worksheet.getCell("G5").value = invoice.accountNumber || "";

    // Period information
    worksheet.getCell("A6").value = "Period From:";
    worksheet.getCell("B6").value = invoice.parcelFrom.toDateString();
    worksheet.getCell("A7").value = "Period To:";
    worksheet.getCell("B7").value = invoice.parcelTo.toDateString();

    // Table headers (starting from row 9)
    const headerRow = 9;
    const headers = [
      "CN/Booking ID",
      "Date",
      "Consignee",
      "Destination",
      "Weight (kg)",
      "COD Amount",
      "Charges",
      "Status",
    ];

    headers.forEach((header, index) => {
      const cell = worksheet.getCell(headerRow, index + 1);
      cell.value = header;
      cell.font = { bold: true };
      cell.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FFE0E0E0" },
      };
      cell.border = {
        top: { style: "thin" },
        left: { style: "thin" },
        bottom: { style: "thin" },
        right: { style: "thin" },
      };
    });

    // Add order data
    let currentRow = headerRow + 1;
    invoice.orders.forEach((order, index) => {
      worksheet.getCell(currentRow, 1).value =
        order.bookingId || order.trackingId;
      worksheet.getCell(currentRow, 2).value = order.createdAt.toDateString();
      worksheet.getCell(currentRow, 3).value = order.consigneeName;
      worksheet.getCell(currentRow, 4).value = order.destinationCity;
      worksheet.getCell(currentRow, 5).value = order.weightKg;
      worksheet.getCell(currentRow, 6).value =
        `PKR ${order.codAmount.toLocaleString()}`;
      worksheet.getCell(currentRow, 7).value =
        `PKR ${order.serviceCharges.toLocaleString()}`;
      worksheet.getCell(currentRow, 8).value = order.status;

      // Add borders to data cells
      for (let col = 1; col <= 8; col++) {
        worksheet.getCell(currentRow, col).border = {
          top: { style: "thin" },
          left: { style: "thin" },
          bottom: { style: "thin" },
          right: { style: "thin" },
        };
      }

      currentRow++;
    });

    // Summary section (starting after the table with some gap)
    const summaryStartRow = currentRow + 2;

    // Summary labels and values
    const summaryData = [
      [
        "COD Total:",
        `PKR ${Number(invoice.codTotal || 0).toLocaleString()}`,
      ],
      [
        "Service Charges:",
        `PKR ${Number(
          invoice.serviceChargesTotal || invoice.flyerChargesTotal || 0,
        ).toLocaleString()}`,
      ],
      [
        "WHT IT u/s 6A of ITO, 2001 (2.0%):",
        `PKR ${Number(invoice.whtIt || 0).toLocaleString()}`,
      ],
      [
        "WHT ST u/s 3 of STA, 1990 (2.0%):",
        `PKR ${Number(invoice.whtSt || 0).toLocaleString()}`,
      ],
      ["", ""], // Empty row
      [
        "Net Payable:",
        `PKR ${Number(invoice.netPayable || 0).toLocaleString()}`,
      ],
    ];

    summaryData.forEach((row, index) => {
      const rowNum = summaryStartRow + index;
      worksheet.getCell(rowNum, 6).value = row[0];
      worksheet.getCell(rowNum, 7).value = row[1];

      if (index === summaryData.length - 1) {
        // Net Payable row
        worksheet.getCell(rowNum, 6).font = { bold: true };
        worksheet.getCell(rowNum, 7).font = { bold: true };
      }
    });

    // Set response headers for file download
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="Invoice_${invoice.invoiceNumber}.xlsx"`,
    );

    // Write workbook to response
    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    next(error);
  }
};
