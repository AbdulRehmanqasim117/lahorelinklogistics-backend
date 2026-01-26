const path = require("path");

// Load env variables as early as possible so that Prisma and other modules
// see the correct configuration (e.g. DATABASE_URL) during initialization.
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const express = require("express");
const cors = require("cors");
const connectDB = require("./config/db");
const errorHandler = require("./middleware/errorHandler");
const webhookRoutes = require("./routes/webhookRoutes");
const prisma = require("./prismaClient");

const NODE_ENV = process.env.NODE_ENV || "development";
const FRONTEND_URL = (process.env.FRONTEND_URL || "").trim();

const ALLOWED_PROD_ORIGINS = [
  "https://lahorelinklogistics.com",
  "https://www.lahorelinklogistics.com",
];

// Allow local development frontends to call the production API without CORS
// errors. This is safe because only a browser on the developer's machine can
// send requests with these origins.
const DEV_LOCALHOST_ORIGINS = [
  "http://localhost:3000",
  "http://127.0.0.1:3000",
];

if (FRONTEND_URL && !ALLOWED_PROD_ORIGINS.includes(FRONTEND_URL)) {
  ALLOWED_PROD_ORIGINS.push(FRONTEND_URL);
}

// Connect to database (Prisma/MySQL only)
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
          if (
            ALLOWED_PROD_ORIGINS.includes(origin) ||
            DEV_LOCALHOST_ORIGINS.includes(origin)
          ) {
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
app.use("/api/setup", require("./routes/setupRoutes"));

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

module.exports = app;
