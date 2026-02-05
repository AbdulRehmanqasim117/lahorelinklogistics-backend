const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth");
const requireRole = require("../middleware/requireRole");
const orderController = require("../controllers/orderController");

router.use(auth);

router.get(
  "/orders.xlsx",
  requireRole("CEO", "MANAGER"),
  orderController.exportOrdersReportXlsx,
);

module.exports = router;
