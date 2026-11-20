import type { AppError } from "../../errors/AppError.js";

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
  | "LIMIT_BELOW_LFT_MINIMUM";

export function withCode<T extends AppError>(error: T, code: HrErrorCode): T {
  error.code = code;
  return error;
}
