const express = require("express");
const cors = require("cors");
const connectDB = require("./config/db");
const errorHandler = require("./middleware/errorHandler");
const bcrypt = require("bcryptjs");
const path = require("path");
const webhookRoutes = require("./routes/webhookRoutes");
const prisma = require("./prismaClient");

// Load env variables
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const NODE_ENV = process.env.NODE_ENV || "development";
const FRONTEND_URL = (process.env.FRONTEND_URL || "").trim();

const ALLOWED_PROD_ORIGINS = [
  "https://lahorelinklogistics.com",
  "https://www.lahorelinklogistics.com",
];

if (FRONTEND_URL && !ALLOWED_PROD_ORIGINS.includes(FRONTEND_URL)) {
  ALLOWED_PROD_ORIGINS.push(FRONTEND_URL);
}

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
// CORS: in production, allow only the configured FRONTEND_URL; in development, reflect the request origin.
const corsOptions = {
  origin:
    NODE_ENV === "production"
      ? (origin, callback) => {
          if (!origin) {
            return callback(null, true);
          }
          if (ALLOWED_PROD_ORIGINS.includes(origin)) {
            return callback(null, true);
          }
          return callback(new Error("Not allowed by CORS"));
        }
      : true,
  credentials: process.env.CORS_ALLOW_CREDENTIALS === "true",
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "X-Requested-With",
    "X-Shopify-Hmac-Sha256",
    "X-Shopify-Topic",
    "X-Shopify-Shop-Domain",
  ],
};

app.use(cors(corsOptions));

// Webhooks (need raw body for HMAC verification) must be mounted before
// global JSON body parser.
app.use("/webhooks", webhookRoutes);

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

app.get("/health", async (req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: "ok" });
  } catch (err) {
    console.error("Health check DB error", err);
    res.status(500).json({ status: "error" });
  }
});

// Error Handler
app.use(errorHandler);

// Seed CEO and Manager accounts only after DB connects (Prisma-based)
const seedAccounts = async () => {
  try {
    // CEO
    let ceo = await prisma.user.findFirst({ where: { role: "CEO" } });
    if (!ceo) {
      const hash = await bcrypt.hash(CEO_PASSWORD, 10);
      await prisma.user.create({
        data: {
          name: "CEO",
          email: CEO_EMAIL,
          passwordHash: hash,
          role: "CEO",
          status: "ACTIVE",
        },
      });
      console.log("Seeded CEO account");
    } else {
      const updates = {};
      if (ceo.email !== CEO_EMAIL) {
        updates.email = CEO_EMAIL;
      }
      const ceoPasswordOk = await bcrypt.compare(CEO_PASSWORD, ceo.passwordHash || "");
      if (!ceoPasswordOk) {
        updates.passwordHash = await bcrypt.hash(CEO_PASSWORD, 10);
      }
      if (Object.keys(updates).length > 0) {
        await prisma.user.update({ where: { id: ceo.id }, data: updates });
      }
    }

    // Manager
    let manager = await prisma.user.findFirst({ where: { role: "MANAGER" } });
    if (!manager) {
      const hash = await bcrypt.hash(MANAGER_PASSWORD, 10);
      await prisma.user.create({
        data: {
          name: "Manager",
          email: MANAGER_EMAIL,
          passwordHash: hash,
          role: "MANAGER",
          status: "ACTIVE",
        },
      });
      console.log("Seeded Manager account");
    } else {
      const updates = {};
      if (manager.email !== MANAGER_EMAIL) {
        updates.email = MANAGER_EMAIL;
      }
      const managerPasswordOk = await bcrypt.compare(
        MANAGER_PASSWORD,
        manager.passwordHash || ""
      );
      if (!managerPasswordOk) {
        updates.passwordHash = await bcrypt.hash(MANAGER_PASSWORD, 10);
      }
      if (Object.keys(updates).length > 0) {
        await prisma.user.update({ where: { id: manager.id }, data: updates });
      }
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

module.exports = app;
