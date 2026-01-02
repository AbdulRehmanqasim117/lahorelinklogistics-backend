const mongoose = require("mongoose");

const invoiceCounterSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      required: true,
      unique: true,
      sparse: true,
      index: true,
    },
    seq: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
    },
  },
  {
    timestamps: true,
  },
);

const formatInvoiceNumber = (seq) => {
  const safeSeq = Number(seq || 0);
  return `A${safeSeq.toString().padStart(5, "0")}`;
};

invoiceCounterSchema.statics.getNextInvoiceNumberPreview = async function () {
  const key = "PAYMENT_INVOICE";
  const counter = await this.findOne({ key }).select("seq").lean();
  if (counter) {
    return formatInvoiceNumber(counter.seq + 1);
  }

  const Invoice = require("./Invoice");
  const latest = await Invoice.findOne({ invoiceNumber: /^A\d{5}$/ })
    .sort({ invoiceNumber: -1 })
    .select("invoiceNumber")
    .lean();

  const latestSeq = latest?.invoiceNumber
    ? Number(String(latest.invoiceNumber).slice(1))
    : 0;

  return formatInvoiceNumber(latestSeq + 1);
};

// Static method to get next invoice number (atomic increment, survives restarts)
invoiceCounterSchema.statics.getNextInvoiceNumber = async function () {
  const key = "PAYMENT_INVOICE";

  while (true) {
    const existing = await this.findOne({ key }).select("_id").lean();
    if (!existing) {
      const Invoice = require("./Invoice");
      const latest = await Invoice.findOne({ invoiceNumber: /^A\d{5}$/ })
        .sort({ invoiceNumber: -1 })
        .select("invoiceNumber")
        .lean();

      const latestSeq = latest?.invoiceNumber
        ? Number(String(latest.invoiceNumber).slice(1))
        : 0;

      try {
        await this.create({ key, seq: latestSeq });
      } catch (e) {
        if (e && e.code === 11000) {
          continue;
        }
        throw e;
      }
    }

    const updated = await this.findOneAndUpdate(
      { key },
      { $inc: { seq: 1 } },
      { new: true },
    );

    return formatInvoiceNumber(updated.seq);
  }
};

module.exports = mongoose.model("InvoiceCounter", invoiceCounterSchema);
