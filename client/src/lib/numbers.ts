/**
 * Numbers in the UI use the real minus sign "−" (U+2212), not the hyphen
 * "-": it is what screen readers read as "menos" and it lines up with "+".
 */
const MINUS = "−";

/** −3, 0, 14 */
export function formatNumber(value: number): string {
  return value < 0 ? `${MINUS}${Math.abs(value)}` : String(value);
}

/** −3, 0, +14: for amounts that add or subtract (a breakdown). */
export function formatSigned(value: number): string {
  return value > 0 ? `+${value}` : formatNumber(value);
}

/** "1 día", "3 días", "−2 días" */
export function formatDays(value: number): string {
  return `${formatNumber(value)} ${Math.abs(value) === 1 ? "día" : "días"}`;
}

/** "1 día hábil", "3 días hábiles" */
export function formatBusinessDays(value: number): string {
  return `${formatNumber(value)} ${Math.abs(value) === 1 ? "día hábil" : "días hábiles"}`;
}
