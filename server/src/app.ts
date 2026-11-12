import "./config/env.js";
import express from "express";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import { authRouter } from "./modules/auth/auth.routes.js";
import { hrRouter } from "./modules/hr/hr.routes.js";
import { leaveTypesRouter } from "./modules/leave-types/leave-types.routes.js";
import { leaveRequestsRouter } from "./modules/leave-requests/leave-requests.routes.js";
import { meRouter } from "./modules/me/me.routes.js";
import { errorHandler } from "./middleware/errorHandler.js";

export function createApp() {
  const app = express();

  app.use(helmet());
  app.use(express.json());
  app.use(cookieParser());

  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.use("/api/auth", authRouter);
  app.use("/api/hr", hrRouter);
  app.use("/api/leave-types", leaveTypesRouter);
  app.use("/api/leave-requests", leaveRequestsRouter);
  app.use("/api/me", meRouter);

  app.use(errorHandler);

  return app;
}
