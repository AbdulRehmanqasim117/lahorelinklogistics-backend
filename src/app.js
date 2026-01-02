const express = require("express");
const cors = require("cors");
const connectDB = require("./config/db");
const mongoose = require("mongoose");
const errorHandler = require("./middleware/errorHandler");
const bcrypt = require("bcryptjs");
const User = require("./models/User");
const path = require("path");

// Load env variables
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const CEO_EMAIL = (process.env.CEO_EMAIL || "").trim();
const CEO_PASSWORD = (process.env.CEO_PASSWORD || "").trim();
const MANAGER_EMAIL = (process.env.MANAGER_EMAIL || "").trim();
const MANAGER_PASSWORD = (process.env.MANAGER_PASSWORD || "").trim();

if (!CEO_EMAIL || !CEO_PASSWORD || !MANAGER_EMAIL || !MANAGER_PASSWORD) {
  throw new Error("CEO or Manager credentials missing in environment variables");
}

// Connect to database
const dbReady = connectDB();

const app = express();

// Middleware
app.use(
  cors({
    // Reflect request origin (allows localhost, devtunnels/ngrok, production domains)
    origin: true,
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  }),
);
app.use(express.json());

// Serve uploaded files statically
app.use("/uploads", express.static("uploads"));

// Routes
app.use("/api/auth", require("./routes/authRoutes"));
app.use("/api/users", require("./routes/userRoutes"));
app.use("/api/orders", require("./routes/orderRoutes"));
app.use("/api/commission", require("./routes/commissionRoutes"));
app.use("/api/finance", require("./routes/financeRoutes"));
app.use("/api/shipper/finance", require("./routes/shipperFinanceRoutes"));
app.use("/api/invoice", require("./routes/invoiceRoutes"));
app.use("/api/integrations", require("./routes/integrationRoutes"));
app.use("/api/dashboard", require("./routes/dashboardRoutes"));
app.use("/api/riders", require("./routes/riderRoutes"));
app.use("/api/notifications", require("./routes/notificationRoutes"));
app.use("/api/company-profile", require("./routes/companyProfileRoutes"));

// Error Handler
app.use(errorHandler);

// Seed CEO and Manager accounts only after DB connects
const seedAccounts = async () => {
  try {
    const ceo = await User.findOne({ role: "CEO" });
    if (!ceo) {
      const hash = await bcrypt.hash(CEO_PASSWORD, 10);
      await User.create({
        name: "CEO",
        email: CEO_EMAIL,
        passwordHash: hash,
        role: "CEO",
      });
      console.log("Seeded CEO account");
    } else {
      let changed = false;
      if (ceo.email !== CEO_EMAIL) {
        ceo.email = CEO_EMAIL;
        changed = true;
      }
      const ceoPasswordOk = await bcrypt.compare(CEO_PASSWORD, ceo.passwordHash || "");
      if (!ceoPasswordOk) {
        ceo.passwordHash = await bcrypt.hash(CEO_PASSWORD, 10);
        changed = true;
      }
      if (changed) await ceo.save();
    }
    const manager = await User.findOne({ role: "MANAGER" });
    if (!manager) {
      const hash = await bcrypt.hash(MANAGER_PASSWORD, 10);
      await User.create({
        name: "Manager",
        email: MANAGER_EMAIL,
        passwordHash: hash,
        role: "MANAGER",
      });
      console.log("Seeded Manager account");
    } else {
      let changed = false;
      if (manager.email !== MANAGER_EMAIL) {
        manager.email = MANAGER_EMAIL;
        changed = true;
      }
      const managerPasswordOk = await bcrypt.compare(
        MANAGER_PASSWORD,
        manager.passwordHash || ""
      );
      if (!managerPasswordOk) {
        manager.passwordHash = await bcrypt.hash(MANAGER_PASSWORD, 10);
        changed = true;
      }
      if (changed) await manager.save();
    }
  } catch (err) {
    console.error("Seeding error", err.message);
  }
};

let seeded = false;
const trySeed = async () => {
  if (seeded) return;
  try {
    await seedAccounts();
    seeded = true;
  } catch (e) {
    // logged inside seedAccounts
  }
};

dbReady.then((ok) => {
  if (ok) {
    trySeed();
  } else {
    console.warn("Skipping seed: DB not connected");
  }
});

mongoose.connection.on("connected", trySeed);

module.exports = app;
