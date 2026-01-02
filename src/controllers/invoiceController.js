const Invoice = require("../models/Invoice");
const InvoiceCounter = require("../models/InvoiceCounter");
const Order = require("../models/Order");
const User = require("../models/User");
const CommissionConfig = require("../models/CommissionConfig");
const ExcelJS = require("exceljs");

// Helper function to calculate service charges if missing
const calculateServiceCharges = async (order) => {
  if (order.serviceCharges > 0) {
    return order.serviceCharges;
  }

  try {
    const commissionConfig = await CommissionConfig.findOne({
      shipper: order.shipper,
    });
    if (
      !commissionConfig ||
      !Array.isArray(commissionConfig.weightBrackets) ||
      commissionConfig.weightBrackets.length === 0
    ) {
      return 0;
    }

    const bracketsSorted = commissionConfig.weightBrackets
      .slice()
      .sort((a, b) => a.minKg - b.minKg);
    const matching = bracketsSorted.find(
      (b) =>
        order.weightKg >= b.minKg &&
        (b.maxKg === null ||
          typeof b.maxKg === "undefined" ||
          order.weightKg < b.maxKg),
    );

    return matching ? matching.charge : 0;
  } catch (error) {
    console.error("Error calculating service charges:", error);
    return 0;
  }
};

// Get orders for invoice (with filters)
exports.getOrdersForInvoice = async (req, res, next) => {
  try {
    const { shipperId, from, to, list = "all" } = req.query;

    if (!shipperId) {
      return res.status(400).json({ message: "Shipper ID is required" });
    }

    const query = {
      shipper: shipperId,
      bookingState: "BOOKED",
    };

    // Date filter
    if (from && to) {
      // Parse dates and set proper time boundaries
      const fromDate = new Date(from);
      const toDate = new Date(to);

      // Set fromDate to start of day (00:00:00.000)
      fromDate.setHours(0, 0, 0, 0);

      // Set toDate to end of day (23:59:59.999)
      toDate.setHours(23, 59, 59, 999);

      query.createdAt = {
        $gte: fromDate,
        $lte: toDate,
      };
    }

    // Invoice status filter
    if (list === "invoiced") {
      query.invoice = { $ne: null };
    } else if (list === "uninvoiced") {
      query.invoice = null;
    }

    const orders = await Order.find(query)
      .populate("shipper", "name email companyName")
      .populate("invoice", "invoiceNumber")
      .sort({ createdAt: -1 })
      .lean();

    // Calculate service charges for orders that don't have them
    const ordersWithCharges = await Promise.all(
      orders.map(async (order) => {
        const serviceCharges = await calculateServiceCharges(order);
        return {
          ...order,
          serviceCharges: order.serviceCharges || serviceCharges,
        };
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

    // Validation
    if (
      !shipperId ||
      !accountName ||
      !selectedOrderIds ||
      selectedOrderIds.length === 0
    ) {
      return res.status(400).json({
        message:
          "Missing required fields: shipperId, accountName, and selectedOrderIds",
      });
    }

    // Fetch selected orders
    const orders = await Order.find({
      _id: { $in: selectedOrderIds },
      shipper: shipperId,
      invoice: null, // Ensure orders are not already invoiced
    });

    if (orders.length === 0) {
      return res
        .status(400)
        .json({ message: "No valid uninvoiced orders found" });
    }

    if (orders.length !== selectedOrderIds.length) {
      return res.status(400).json({
        message:
          "Some orders are already invoiced or do not belong to this shipper",
      });
    }

    // Calculate totals
    let codTotal = 0;
    let serviceChargesTotal = 0;

    for (let order of orders) {
      codTotal += Number(order.codAmount || 0);
      const serviceCharges = await calculateServiceCharges(order);
      serviceChargesTotal += serviceCharges;
    }

    const numericWhtIt = Number(whtIt) || 0;
    const numericWhtSt = Number(whtSt) || 0;

    const netPayable =
      codTotal + serviceChargesTotal - numericWhtIt - numericWhtSt;

    // Generate invoice number
    const invoiceNumber = await InvoiceCounter.getNextInvoiceNumber();

    // Create invoice
    const invoice = new Invoice({
      invoiceNumber,
      shipper: shipperId,
      accountName,
      accountNumber: accountNumber || "",
      invoiceDate: invoiceDate || new Date(),
      parcelFrom: new Date(parcelFrom),
      parcelTo: new Date(parcelTo),
      orders: selectedOrderIds,
      codTotal,
      flyerChargesTotal: serviceChargesTotal,
      serviceChargesTotal,
      whtIt: numericWhtIt,
      whtSt: numericWhtSt,
      netPayable,
      createdBy: req.user.id,
    });

    await invoice.save();

    // Update orders with invoice reference
    await Order.updateMany(
      { _id: { $in: selectedOrderIds } },
      {
        $set: {
          invoice: invoice._id,
          invoicedAt: new Date(),
        },
      },
    );

    // Populate the saved invoice for response
    const populatedInvoice = await Invoice.findById(invoice._id)
      .populate("shipper", "name email companyName phone address")
      .populate("orders")
      .populate("createdBy", "name");

    res.status(201).json({
      message: "Invoice created successfully",
      invoice: populatedInvoice,
    });
  } catch (error) {
    next(error);
  }
};

// Get invoice by ID
exports.getInvoice = async (req, res, next) => {
  try {
    const { id } = req.params;

    const invoice = await Invoice.findById(id)
      .populate("shipper", "name email companyName phone address")
      .populate("orders")
      .populate("createdBy", "name");

    if (!invoice) {
      return res.status(404).json({ message: "Invoice not found" });
    }

    res.json(invoice);
  } catch (error) {
    next(error);
  }
};

// Get invoice list
exports.getInvoices = async (req, res, next) => {
  try {
    const { shipperId, from, to, page = 1, limit = 20 } = req.query;

    const query = {};

    if (shipperId) {
      query.shipper = shipperId;
    }

    if (from && to) {
      query.invoiceDate = {
        $gte: new Date(from),
        $lte: new Date(to),
      };
    }

    const invoices = await Invoice.find(query)
      .populate("shipper", "name email companyName")
      .populate("createdBy", "name")
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);

    const total = await Invoice.countDocuments(query);

    res.json({
      invoices,
      totalPages: Math.ceil(total / limit),
      currentPage: page,
      total,
    });
  } catch (error) {
    next(error);
  }
};

// Get next invoice number (for preview)
exports.getNextInvoiceNumber = async (req, res, next) => {
  try {
    const nextNumber = await InvoiceCounter.getNextInvoiceNumber();

    // Rollback the counter since this was just for preview
    const today = new Date();
    const dateStr =
      today.getDate().toString().padStart(2, "0") +
      (today.getMonth() + 1).toString().padStart(2, "0") +
      today.getFullYear().toString().slice(-2);

    await InvoiceCounter.findOneAndUpdate(
      { date: dateStr },
      { $inc: { counter: -1 } },
    );

    res.json({ invoiceNumber: nextNumber });
  } catch (error) {
    next(error);
  }
};

// Get all shippers for dropdown
exports.getShippers = async (req, res, next) => {
  try {
    const shippers = await User.find(
      { role: "SHIPPER" },
      // Include structured bank fields so invoice UI can prefill account details
      "name email companyName phone address bankName accountHolderName accountNumber iban",
    ).sort({ name: 1 });

    res.json(shippers);
  } catch (error) {
    next(error);
  }
};

// Export invoice to Excel
exports.exportInvoiceToExcel = async (req, res, next) => {
  try {
    const { id } = req.params;

    // Fetch invoice with populated data
    const invoice = await Invoice.findById(id)
      .populate("shipper", "name email companyName phone address")
      .populate("orders")
      .populate("createdBy", "name");

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
    worksheet.getCell("G5").value = invoice.accountNumber;

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
