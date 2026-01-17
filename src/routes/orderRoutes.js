const express = require("express");
const router = express.Router();
const orderController = require("../controllers/orderController");
const financeController = require("../controllers/financeController");
const auth = require("../middleware/auth");
const requireRole = require("../middleware/requireRole");
const requireCommissionApproved = require("../middleware/requireCommissionApproved");
const requireRiderCommissionConfigured = require("../middleware/requireRiderCommissionConfigured");

router.use(auth);

// Create: Shipper only
router.post(
  "/",
  requireRole("SHIPPER"),
  requireCommissionApproved,
  orderController.createOrder,
);

// Read: All roles (filtered by controller)
// Shipper portal is gated by requireCommissionApproved, riders by requireRiderCommissionConfigured
router.get("/", requireCommissionApproved, requireRiderCommissionConfigured, orderController.getOrders);
router.get(
  "/summary/manager",
  requireRole("MANAGER"),
  orderController.getManagerOverview,
);
// Get Order Details by Booking ID (Read-only for Riders) - Must be before /:id
router.get("/details/:bookingId", orderController.getOrderDetailsByBookingId);
router.get("/:id", orderController.getOrderById);

// CEO-only order edit with audit logging
router.patch(
  "/:id",
  requireRole("CEO"),
  orderController.ceoEditOrder,
);

// Read Label
router.get("/:id/label", orderController.getLabel);
router.get("/labels", orderController.getLabels);
router.post(
  "/labels/print",
  requireRole("SHIPPER"),
  requireCommissionApproved,
  orderController.printLabelsHtml,
);

// Assign: CEO or Manager
router.patch(
  "/:id/assign",
  requireRole("CEO", "MANAGER"),
  orderController.assignRider,
);

// Status: Rider, Manager, or CEO
router.patch(
  "/:id/status",
  requireRole("RIDER", "MANAGER", "CEO"),
  requireRiderCommissionConfigured,
  orderController.updateStatus,
);

// Rider settlement (CEO/Manager only)
router.patch(
  "/:id/rider-settlement",
  requireRole("CEO", "MANAGER"),
  financeController.setRiderSettlementByOrder,
);

// Book an unbooked order: Shipper only
router.patch(
  "/:id/book",
  requireRole("SHIPPER"),
  requireCommissionApproved,
  orderController.bookOrder,
);

// Pending integrated orders:
// - SHIPPER sees their own pending integrated orders (gated by commission config)
// - CEO / MANAGER see all pending integrated orders across shippers
router.get(
  "/integrated/pending",
  requireRole("SHIPPER", "CEO", "MANAGER"),
  requireCommissionApproved,
  orderController.getPendingIntegratedOrdersForShipper,
);

// Shipper: delete/reject a pending integrated order (soft delete)
router.patch(
  "/:id/reject",
  requireRole("SHIPPER"),
  requireCommissionApproved,
  orderController.rejectIntegratedOrder,
);

// CEO Assign Order by QR Scan
router.post("/assign-by-scan", requireRole("CEO", "MANAGER"), orderController.assignByScan);

// Get Order Details by Booking ID (Read-only for Riders)
// This route must be before /:id to avoid conflicts
router.get("/details/:bookingId", orderController.getOrderDetailsByBookingId);

// Scanner: CEO or Manager - Scan QR to mark order as arrived at LLL warehouse
const scannerController = require("../controllers/scannerController");
router.post(
  "/scan",
  requireRole("CEO", "MANAGER"),
  scannerController.scanOrder,
);

// Enhanced warehouse scan with weight verification
router.get(
  "/:bookingId/scan-preview",
  requireRole("CEO", "MANAGER"),
  scannerController.getOrderForScan,
);
router.post(
  "/:bookingId/warehouse-scan",
  requireRole("CEO", "MANAGER"),
  scannerController.warehouseScan,
);

module.exports = router;
