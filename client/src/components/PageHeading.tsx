import type { ReactNode } from "react";

interface PageHeadingProps {
  title: string;
  description?: ReactNode;
}

export const APP_NAME = "Leave Manager";

/**
 * The page's main heading. `tabIndex={-1}` lets AppLayout move focus here by
 * code after a route change (so screen readers announce the new section)
 * without adding the heading to the Tab order. It also sets the tab title:
 * React 19 hoists `<title>` into `<head>`.
 */
export function PageHeading({ title, description }: PageHeadingProps) {
  return (
    <header className="mb-6 space-y-1">
      <title>{`${title} · ${APP_NAME}`}</title>
      <h1 tabIndex={-1} className="text-2xl font-semibold tracking-tight focus:outline-none">
        {title}
      </h1>
      {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
    </header>
  );
}
