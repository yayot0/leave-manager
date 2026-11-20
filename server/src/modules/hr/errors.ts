import { createWithCode } from "../../errors/AppError.js";

/**
 * Machine-readable reasons of the HR catalog errors, sent as `code` so the
 * client reacts to the reason instead of parsing the message.
 */
export type HrErrorCode =
  | "DUPLICATE_NAME"
  | "DUPLICATE_CODE"
  | "DUPLICATE_DATE"
  | "DEPARTMENT_HAS_EMPLOYEES"
  /** Someone saved the entity after the client loaded it (expectedUpdatedAt differs). */
  | "STALE_DATA"
  /** A type that counts against vacations would cap requests below 12 days (Art. 78 LFT). */
  | "LIMIT_BELOW_LFT_MINIMUM"
  /** HR tried to reset its own password (it must use change-password). */
  | "CANNOT_RESET_OWN_PASSWORD"
  /** The employee is inactive: a password reset would be pointless. */
  | "EMPLOYEE_INACTIVE";

export const withCode = createWithCode<HrErrorCode>();
