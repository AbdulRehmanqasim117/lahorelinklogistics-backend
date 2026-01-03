const mongoose = require("mongoose");

const orderSchema = new mongoose.Schema(
  {
    bookingId: {
      type: String,
      unique: true,
      index: true,
    },
    trackingId: {
      type: String,
      unique: true,
      index: true,
    },
    shipper: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    externalOrderId: {
      type: String,
      index: true,
    },
    assignedRider: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true, // Index for faster rider dashboard queries
    },

    consigneeName: { type: String, required: true },
    consigneePhone: { type: String, required: true },
    consigneeAddress: { type: String, required: true },
    destinationCity: { type: String, required: true },

    serviceType: {
      type: String,
      enum: ["SAME_DAY", "OVERNIGHT", "ECONOMY"],
      required: true,
    },
    paymentType: {
      type: String,
      enum: ["COD", "ADVANCE"],
      default: "COD",
    },
    codAmount: { type: Number, default: 0 },
    productDescription: { type: String },
    pieces: { type: Number, default: 1 },
    fragile: { type: Boolean, default: false },
    weightKg: { type: Number, required: true, min: 0 },
    weightOriginalKg: { type: Number }, // Original weight before warehouse verification
    weightVerifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    weightVerifiedAt: { type: Date },
    weightSource: {
      type: String,
      enum: ["SHIPPER", "WAREHOUSE_SCAN", "MANUAL"],
      default: "SHIPPER",
    },
    // Deprecated: weight, weightCategory (remove in UI/api next)
    remarks: { type: String },

    status: {
      type: String,
      enum: [
        "CREATED",
        "ASSIGNED",
        "AT_LLL_WAREHOUSE", // Order has arrived at LLL warehouse (scanned via QR)
        "OUT_FOR_DELIVERY",
        "DELIVERED",
        "RETURNED",
        "FAILED",
        "FIRST_ATTEMPT",
        "SECOND_ATTEMPT",
        "THIRD_ATTEMPT",
      ],
      default: "CREATED",
      index: true,
    },

    statusHistory: [
      {
        status: String,
        timestamp: { type: Date, default: Date.now },
        updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
        note: String,
      },
    ],

    deliveredAt: { type: Date },
    outForDeliveryAt: { type: Date }, // Timestamp when order was marked OUT_FOR_DELIVERY
    amountCollected: { type: Number },
    failedReason: { type: String },
    serviceCharges: { type: Number, required: true, default: 0 },
    serviceChargesCalcSnapshot: {
      weightUsed: { type: Number },
      bracketMin: { type: Number },
      bracketMax: { type: Number },
      rate: { type: Number },
      calculatedAt: { type: Date },
    },
    totalAmount: { type: Number, default: 0 },

    // Invoice related fields
    invoice: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Invoice",
      default: null,
      index: true,
    },
    invoicedAt: {
      type: Date,
      default: null,
    },

    // Warehouse tracking
    warehouseReceivedAt: { type: Date },
    warehouseReceivedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },

    // Weight change audit log
    weightChangeLog: [
      {
        oldWeightKg: { type: Number },
        newWeightKg: { type: Number },
        changedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
        changedAt: { type: Date, default: Date.now },
        reason: { type: String, default: "Warehouse scan" },
      },
    ],

    // Integration and booking status
    isIntegrated: {
      type: Boolean,
      default: false,
    },
    bookingState: {
      type: String,
      enum: ["UNBOOKED", "BOOKED"],
      default: "BOOKED", // for normal/manual orders
    },
    bookedWithLLL: {
      type: Boolean,
      default: false,
      index: true,
    },
    isDeleted: {
      type: Boolean,
      default: false,
    },
    shipperApprovalStatus: {
      type: String,
      default: "approved",
    },
    source: {
      type: String,
    },
    sourceMeta: {
      shopDomain: { type: String },
      providerOrderId: { type: String },
      providerOrderNumber: { type: String },
    },
  },
  {
    timestamps: true,
  },
);

module.exports = mongoose.model("Order", orderSchema);
