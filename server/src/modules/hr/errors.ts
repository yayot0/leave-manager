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
  | "EMPLOYEE_INACTIVE"
  // ---------- Employees (RH-B2) ----------
  | "DUPLICATE_EMAIL"
  /** The department was deleted (or never existed). */
  | "DEPARTMENT_NOT_FOUND"
  /** managerId = the employee's own id. */
  | "MANAGER_IS_SELF"
  /** The new manager reports (directly or not) to the employee. */
  | "MANAGER_CYCLE"
  /** The manager does not exist, is inactive or is not MANAGER/HR. */
  | "MANAGER_NOT_ELIGIBLE"
  /** Demoting to EMPLOYEE or deactivating someone with active direct reports. */
  | "HAS_ACTIVE_REPORTS"
  /** The change would leave no active HR user. */
  | "LAST_ACTIVE_HR"
  /** Deactivating with PENDING requests that already started: someone must decide them first. */
  | "HAS_OVERDUE_PENDING_REQUESTS"
  /** The new hireDate is after the start of an active request. */
  | "HIRE_DATE_AFTER_REQUESTS"
  /** More than one year after today. */
  | "HIRE_DATE_OUT_OF_RANGE"
  | "EMPLOYEE_ALREADY_ACTIVE"
  // Segregation of duties: HR never changes its own data that gives it an advantage.
  | "CANNOT_CHANGE_OWN_ROLE"
  | "CANNOT_DEACTIVATE_SELF"
  | "CANNOT_EDIT_OWN_HIRE_DATE"
  | "CANNOT_CHANGE_OWN_MANAGER";

export const withCode = createWithCode<HrErrorCode>();
