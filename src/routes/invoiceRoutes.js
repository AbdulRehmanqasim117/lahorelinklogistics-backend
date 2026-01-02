const express = require("express");
const router = express.Router();
const invoiceController = require("../controllers/invoiceController");
const auth = require("../middleware/auth");
const requireRole = require("../middleware/requireRole");

// All routes require authentication and CEO/MANAGER role
router.use(auth, requireRole("CEO", "MANAGER"));

// GET /api/invoice/shippers - Get all shippers for dropdown
router.get("/shippers", invoiceController.getShippers);

// GET /api/invoice/orders - Get orders for invoice creation (with filters)
router.get("/orders", invoiceController.getOrdersForInvoice);

// GET /api/invoice/next-number - Get next invoice number for preview
router.get("/next-number", invoiceController.getNextInvoiceNumber);

// POST /api/invoice - Create new invoice
router.post("/", invoiceController.createInvoice);

// GET /api/invoice - Get invoice list
router.get("/", invoiceController.getInvoices);

// GET /api/invoice/:id - Get specific invoice
router.get("/:id", invoiceController.getInvoice);

// GET /api/invoice/:id/export.xlsx - Export invoice to Excel
router.get("/:id/export.xlsx", invoiceController.exportInvoiceToExcel);

module.exports = router;
