import { Router } from "express";
import { requireAuth } from "../../middleware/requireAuth.js";
import { UnauthorizedError } from "../../errors/AppError.js";
import { createLeaveRequestSchema } from "./leave-requests.schemas.js";
import { createLeaveRequest, listMyLeaveRequests } from "./leave-requests.service.js";

export const leaveRequestsRouter = Router();

leaveRequestsRouter.use(requireAuth);

leaveRequestsRouter.post("/", async (req, res) => {
  if (!req.user) throw new UnauthorizedError();
  const input = createLeaveRequestSchema.parse(req.body);
  const leaveRequest = await createLeaveRequest(req.user, input);
  res.status(201).json({ leaveRequest });
});

leaveRequestsRouter.get("/mine", async (req, res) => {
  if (!req.user) throw new UnauthorizedError();
  const leaveRequests = await listMyLeaveRequests(req.user.id);
  res.json({ leaveRequests });
});
