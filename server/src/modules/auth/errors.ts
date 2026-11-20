import { createWithCode } from "../../errors/AppError.js";
import type { PasswordPolicyProblem } from "../../security/password-policy.js";

/**
 * Machine-readable reasons of the account errors, sent as `code` so the
 * client reacts to the reason instead of parsing the message.
 */
export type AuthErrorCode =
  | PasswordPolicyProblem
  /** The new password is the same as the current one. */
  | "PASSWORD_UNCHANGED"
  /** change-password: the current password is wrong (400, not 401: the session is fine). */
  | "INVALID_CURRENT_PASSWORD"
  /** The password is temporary: only /auth/me, /auth/change-password and logout work. */
  | "PASSWORD_CHANGE_REQUIRED"
  /** The password changed (e.g. HR reset) while this change was being processed. */
  | "STALE_DATA"
  /** Rate limit of login or change-password. */
  | "TOO_MANY_ATTEMPTS";

export const withAuthCode = createWithCode<AuthErrorCode>();
