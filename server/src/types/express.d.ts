import type { PublicUser } from "../modules/auth/public-user.js";

declare global {
  namespace Express {
    interface Request {
      user?: PublicUser;
    }
  }
}
