import { Router, type Request } from "express";
import { requireAuth } from "../../middleware/requireAuth.js";
import { UnauthorizedError } from "../../errors/AppError.js";
import type { PublicUser } from "../auth/public-user.js";
import {
  createLeaveRequestSchema,
  leaveRequestIdSchema,
  optionalNoteSchema,
  requiredNoteSchema,
} from "./leave-requests.schemas.js";
import { createLeaveRequest, listMyLeaveRequests } from "./leave-requests.service.js";
import {
  applyLeaveRequestAction,
  getLeaveRequestDetail,
  listPendingApprovals,
} from "./leave-request-decisions.service.js";

export const leaveRequestsRouter = Router();

leaveRequestsRouter.use(requireAuth);

function authUser(req: Request): PublicUser {
  if (!req.user) throw new UnauthorizedError();
  return req.user;
}

leaveRequestsRouter.post("/", async (req, res) => {
  const input = createLeaveRequestSchema.parse(req.body);
  const leaveRequest = await createLeaveRequest(authUser(req), input);
  res.status(201).json({ leaveRequest });
});

// Static paths must be declared before "/:id" so they are not taken as ids.
leaveRequestsRouter.get("/mine", async (req, res) => {
  const leaveRequests = await listMyLeaveRequests(authUser(req).id);
  res.json({ leaveRequests });
});

leaveRequestsRouter.get("/pending-approvals", async (req, res) => {
  const leaveRequests = await listPendingApprovals(authUser(req));
  res.json({ leaveRequests });
});

leaveRequestsRouter.get("/:id", async (req, res) => {
  const id = leaveRequestIdSchema.parse(req.params.id);
  const leaveRequest = await getLeaveRequestDetail(authUser(req), id);
  res.json({ leaveRequest });
});

// express.json() leaves req.body undefined when no body is sent; an empty
// object lets "no note" work for approve/cancel.
leaveRequestsRouter.post("/:id/approve", async (req, res) => {
  const id = leaveRequestIdSchema.parse(req.params.id);
  const { note } = optionalNoteSchema.parse(req.body ?? {});
  const leaveRequest = await applyLeaveRequestAction(authUser(req), id, "APPROVE", note);
  res.json({ leaveRequest });
});

leaveRequestsRouter.post("/:id/reject", async (req, res) => {
  const id = leaveRequestIdSchema.parse(req.params.id);
  const { note } = requiredNoteSchema.parse(req.body ?? {});
  const leaveRequest = await applyLeaveRequestAction(authUser(req), id, "REJECT", note);
  res.json({ leaveRequest });
});

leaveRequestsRouter.post("/:id/cancel", async (req, res) => {
  const id = leaveRequestIdSchema.parse(req.params.id);
  const { note } = optionalNoteSchema.parse(req.body ?? {});
  const leaveRequest = await applyLeaveRequestAction(authUser(req), id, "CANCEL", note);
  res.json({ leaveRequest });
});
