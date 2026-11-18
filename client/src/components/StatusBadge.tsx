import { Ban, CircleCheck, CircleX, Clock, type LucideIcon } from "lucide-react";
import type { LeaveRequestStatus } from "@/api/types";
import { cn } from "@/lib/utils";

interface StatusStyle {
  label: string;
  icon: LucideIcon;
  className: string;
}

/**
 * Each status has its own text and icon, so it never depends on color alone
 * (WCAG 1.4.1); the color only reinforces it.
 */
const STATUS_STYLES: Record<LeaveRequestStatus, StatusStyle> = {
  PENDING: {
    label: "Pendiente",
    icon: Clock,
    className: "bg-amber-100 text-amber-900 dark:bg-amber-500/15 dark:text-amber-300",
  },
  APPROVED: {
    label: "Aprobada",
    icon: CircleCheck,
    className: "bg-emerald-100 text-emerald-900 dark:bg-emerald-500/15 dark:text-emerald-300",
  },
  REJECTED: {
    label: "Rechazada",
    icon: CircleX,
    className: "bg-red-100 text-red-900 dark:bg-red-500/15 dark:text-red-300",
  },
  CANCELLED: {
    label: "Cancelada",
    icon: Ban,
    // neutral-700 on muted: ~9:1 (muted-foreground gave ~4.4:1, below the 4.5:1 for small text).
    className: "bg-muted text-neutral-700 dark:text-neutral-300",
  },
};

export function StatusBadge({ status, className }: { status: LeaveRequestStatus; className?: string }) {
  const { label, icon: Icon, className: statusClassName } = STATUS_STYLES[status];
  return (
    <span
      className={cn(
        "inline-flex w-fit items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap",
        statusClassName,
        className,
      )}
    >
      <Icon className="size-3.5" aria-hidden="true" />
      {label}
    </span>
  );
}
