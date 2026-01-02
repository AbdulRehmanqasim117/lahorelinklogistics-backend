const mongoose = require("mongoose");

const invoiceSchema = new mongoose.Schema(
  {
    invoiceNumber: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    shipper: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    accountName: {
      type: String,
      required: true,
    },
    accountNumber: {
      type: String,
      default: "",
    },
    invoiceDate: {
      type: Date,
      required: true,
      default: Date.now,
    },
    parcelFrom: {
      type: Date,
      required: true,
    },
    parcelTo: {
      type: Date,
      required: true,
    },
    orders: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Order",
      },
    ],
    // Financial calculations (all in PKR)
    codTotal: {
      type: Number,
      required: true,
      default: 0,
    },
    flyerChargesTotal: {
      type: Number,
      required: true,
      default: 0,
    },
    // Aggregate of per-order service charges
    serviceChargesTotal: {
      type: Number,
      required: true,
      default: 0,
    },
    // Backwards-compat extra charge fields (no longer used in new invoices)
    fuelCharges: {
      type: Number,
      default: 0,
    },
    otherCharges: {
      type: Number,
      default: 0,
    },
    discount: {
      type: Number,
      default: 0,
    },
    // Withholding taxes (amounts)
    whtIt: {
      type: Number,
      default: 0,
    },
    whtSt: {
      type: Number,
      default: 0,
    },
    netPayable: {
      type: Number,
      required: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    status: {
      type: String,
      enum: ["DRAFT", "FINALIZED", "PAID"],
      default: "FINALIZED",
    },
  },
  {
    timestamps: true,
  },
);

// Index for efficient queries
invoiceSchema.index({ shipper: 1, invoiceDate: -1 });
invoiceSchema.index({ createdAt: -1 });

module.exports = mongoose.model("Invoice", invoiceSchema);
