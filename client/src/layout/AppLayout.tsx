import { useEffect, useRef, useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router";
import { CalendarDays, LogOut, Menu } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { useLogout } from "@/auth/session";
import { useCurrentUser } from "@/auth/current-user";
import { navItemsFor, ROLE_LABELS } from "@/app/navigation";
import type { Role } from "@/api/types";
import { APP_NAME } from "@/components/PageHeading";

interface MainNavProps {
  role: Role;
  onNavigate?: (to: string) => void;
}

/** Menu of the sections the role can open (same list as the routes). */
function MainNav({ role, onNavigate }: MainNavProps) {
  return (
    <nav aria-label="Principal">
      <ul className="space-y-1">
        {navItemsFor(role).map(({ to, label, icon: Icon }) => (
          <li key={to}>
            <NavLink
              to={to}
              end
              onClick={() => onNavigate?.(to)}
              className={({ isActive }) =>
                cn(
                  "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
                  isActive
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground",
                )
              }
            >
              <Icon className="size-4 shrink-0" aria-hidden="true" />
              {label}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}

export function AppLayout() {
  const user = useCurrentUser();
  const logout = useLogout();
  const location = useLocation();
  const mainRef = useRef<HTMLElement>(null);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  // True when the mobile menu closes because the user picked another section.
  const mobileMenuJustNavigated = useRef(false);

  const handleMobileMenuOpenChange = (open: boolean) => {
    if (open) {
      mobileMenuJustNavigated.current = false;
    }
    setMobileMenuOpen(open);
  };

  const handleMobileNavigate = (to: string) => {
    // Same section: no route change, so let the dialog return focus to the
    // menu button as usual.
    mobileMenuJustNavigated.current = to !== location.pathname;
    setMobileMenuOpen(false);
  };

  // Where the dialog puts focus once it has fully closed. After choosing a
  // section it is the new page's <h1>, not the menu button. The effect below
  // may run while the modal still marks the rest of the page inert, so the
  // dialog's own final focus is what reliably lands there.
  // `true` = default behavior (back to the menu button).
  const mobileMenuFinalFocus = (): HTMLElement | boolean =>
    (mobileMenuJustNavigated.current && mainRef.current?.querySelector<HTMLElement>("h1")) || true;

  // Move focus to the new page's <h1> after an in-app navigation, so screen
  // readers announce the section and the next Tab starts from the content.
  // Comparing with the previous pathname (instead of a "first render" flag)
  // skips the initial load and is safe under StrictMode's double effects.
  const previousPathname = useRef(location.pathname);
  useEffect(() => {
    if (previousPathname.current === location.pathname) {
      return;
    }
    previousPathname.current = location.pathname;
    mainRef.current?.querySelector<HTMLHeadingElement>("h1")?.focus();
  }, [location.pathname]);

  const fullName = `${user.firstName} ${user.lastName}`;

  const userSummary = (
    <div className="min-w-0 text-sm">
      <p className="truncate font-medium">{fullName}</p>
      <p className="truncate text-muted-foreground">{ROLE_LABELS[user.role]}</p>
    </div>
  );

  const logoutButton = (
    <Button variant="outline" onClick={() => logout.mutate()} disabled={logout.isPending}>
      <LogOut aria-hidden="true" />
      {logout.isPending ? "Cerrando sesión…" : "Cerrar sesión"}
    </Button>
  );

  return (
    <div className="min-h-dvh bg-muted/40">
      <a
        href="#main"
        className="sr-only z-50 rounded-lg bg-background px-3 py-2 text-sm font-medium shadow focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
      >
        Saltar al contenido
      </a>

      <header className="sticky top-0 z-40 border-b bg-background">
        <div className="flex h-14 items-center gap-3 px-4 md:px-6">
          <Sheet open={mobileMenuOpen} onOpenChange={handleMobileMenuOpenChange}>
            <SheetTrigger
              render={<Button variant="ghost" size="icon" className="md:hidden" aria-label="Abrir menú" />}
            >
              <Menu aria-hidden="true" />
            </SheetTrigger>
            <SheetContent
              side="left"
              className="w-72"
              finalFocus={mobileMenuFinalFocus}
            >
              <SheetHeader>
                <SheetTitle>{APP_NAME}</SheetTitle>
              </SheetHeader>
              <div className="flex flex-1 flex-col gap-6 px-4 pb-4">
                <MainNav role={user.role} onNavigate={handleMobileNavigate} />
                <div className="mt-auto space-y-3 border-t pt-4">
                  {userSummary}
                  {logoutButton}
                </div>
              </div>
            </SheetContent>
          </Sheet>

          <div className="flex items-center gap-2 font-semibold">
            <CalendarDays className="size-5" aria-hidden="true" />
            <span>{APP_NAME}</span>
          </div>

          <div className="ml-auto hidden items-center gap-4 md:flex">
            <div className="text-right">{userSummary}</div>
            {logoutButton}
          </div>
        </div>
      </header>

      <div className="mx-auto flex max-w-6xl">
        <aside className="hidden w-60 shrink-0 border-r bg-background p-4 md:block md:min-h-[calc(100dvh-3.5rem)]">
          <MainNav role={user.role} />
        </aside>

        <main id="main" ref={mainRef} tabIndex={-1} className="min-w-0 flex-1 p-4 focus:outline-none md:p-8">
          {logout.isError ? (
            <p role="alert" className="mb-4 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              No se pudo cerrar la sesión: {logout.error.message}
            </p>
          ) : null}
          <Outlet />
        </main>
      </div>
    </div>
  );
}
