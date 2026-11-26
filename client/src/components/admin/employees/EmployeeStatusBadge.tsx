import { CircleCheck, CircleSlash } from "lucide-react";
import { cn } from "@/lib/utils";

/** Active or deactivated: text and icon, never color alone (WCAG 1.4.1). */
export function EmployeeStatusBadge({ isActive }: { isActive: boolean }) {
  const Icon = isActive ? CircleCheck : CircleSlash;
  return (
    <span
      className={cn(
        "inline-flex w-fit items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap",
        isActive
          ? "bg-emerald-100 text-emerald-900 dark:bg-emerald-500/15 dark:text-emerald-300"
          : "bg-muted text-neutral-700 dark:text-neutral-300",
      )}
    >
      <Icon className="size-3.5" aria-hidden="true" />
      {isActive ? "Activo" : "Dado de baja"}
    </span>
  );
}
