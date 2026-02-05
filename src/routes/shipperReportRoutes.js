const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth");
const requireRole = require("../middleware/requireRole");
const requireCommissionApproved = require("../middleware/requireCommissionApproved");
const orderController = require("../controllers/orderController");

router.use(auth);

router.get(
  "/orders.xlsx",
  requireRole("SHIPPER"),
  requireCommissionApproved,
  orderController.exportShipperOrdersReportXlsx,
);

module.exports = router;
