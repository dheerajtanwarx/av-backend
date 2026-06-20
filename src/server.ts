import "dotenv/config";
import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import passport from "passport";
import { configurePassport } from "./config/passport";
import authRouter from "./routes/auth";
import productsRouter from "./routes/products";
import categoriesRouter from "./routes/categories";
import promosRouter from "./routes/promos";
import newsletterRouter from "./routes/newsletter";
import ordersRouter from "./routes/orders";
import {
  orderRequestsRouter,
  adminOrderRequestsRouter,
} from "./routes/orderRequests";
import cartRouter from "./routes/cart";
import wishlistRouter from "./routes/wishlist";
import addressesRouter from "./routes/addresses";
import reviewsRouter from "./routes/reviews";
import adminRouter from "./routes/admin";
import adminProductsRouter from "./routes/adminProducts";
import inventoryRouter from "./routes/inventory";
import customersRouter from "./routes/customers";
import reportsRouter from "./routes/reports";
import settingsRouter from "./routes/settings";
import notificationsRouter from "./routes/notifications";
import activityRouter from "./routes/activity";
import realtimeRouter from "./routes/realtime";
import trackRouter from "./routes/track";
import goRouter from "./routes/go";
import analyticsRouter from "./routes/analytics";
import { startAnalyticsJobs } from "./analytics/scheduler";
import { startLiveMetrics } from "./analytics/live";

const app = express();
const PORT = Number(process.env.PORT ?? 4000);
const FRONTEND_URL = process.env.FRONTEND_URL ?? "http://localhost:3000";

// Behind Render/Vercel proxies; honour X-Forwarded-For so req.ip and the
// analytics geo-IP lookup see the real client address, not the proxy's.
app.set("trust proxy", true);

app.use(
  cors({
    origin: FRONTEND_URL,
    credentials: true,
  })
);

app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());

configurePassport();
app.use(passport.initialize());

app.use("/api/auth", authRouter);

app.use("/api/products", productsRouter);
app.use("/api/categories", categoriesRouter);
app.use("/api/promos", promosRouter);
app.use("/api/newsletter", newsletterRouter);
app.use("/api/orders", ordersRouter);
app.use("/api/order-requests", orderRequestsRouter);
app.use("/api/cart", cartRouter);
app.use("/api/wishlist", wishlistRouter);
app.use("/api/addresses", addressesRouter);
app.use("/api/reviews", reviewsRouter);
app.use("/api/admin/products", adminProductsRouter);
app.use("/api/admin/inventory", inventoryRouter);
app.use("/api/admin/customers", customersRouter);
app.use("/api/admin/reports", reportsRouter);
app.use("/api/admin/notifications", notificationsRouter);
app.use("/api/admin/activity", activityRouter);
app.use("/api/admin/realtime", realtimeRouter);
app.use("/api/admin/analytics", analyticsRouter);
app.use("/api/admin/order-requests", adminOrderRequestsRouter);
app.use("/api/admin", adminRouter);
app.use("/api/settings", settingsRouter);

// Public analytics event collector (no auth — anonymous visitors).
app.use("/api/track", trackRouter);
// Marketing short links / QR targets (root-mounted for short printed URLs).
app.use("/go", goRouter);

app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`Express server running on http://localhost:${PORT}`);
  // Kick off the rollup / session-close cron jobs + the live metrics tick.
  startAnalyticsJobs();
  startLiveMetrics();
});

export default app;
