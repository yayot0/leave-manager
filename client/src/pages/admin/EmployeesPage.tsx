import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Link, useLocation, useSearchParams } from "react-router";
import { ChevronLeft, ChevronRight, Search, TriangleAlert, Users } from "lucide-react";
import type { Employee, EmployeeFilters, EmployeeStatusFilter, Role } from "@/api/types";
import { ROLE_LABELS } from "@/app/navigation";
import { employeeDetailPath, fromEmployeeListState } from "@/app/paths";
import { useDepartments, useEmployees } from "@/hooks/hr";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useEntityDialog } from "@/hooks/use-entity-dialog";
import { formatDate } from "@/lib/dates";
import { cn } from "@/lib/utils";
import { ActionStatus } from "@/components/admin/ActionStatus";
import { AdminSubnav } from "@/components/admin/AdminSubnav";
import { EmployeeFormDialog, type EmployeeFormTarget } from "@/components/admin/employees/EmployeeFormDialog";
import { PageHeading } from "@/components/PageHeading";
import { LoadingBlock, QueryError } from "@/components/QueryStatus";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmployeeStatusBadge } from "@/components/admin/employees/EmployeeStatusBadge";

const SEARCH_DEBOUNCE_MS = 300;
/** = the API's max page (employeesQuerySchema). */
const MAX_PAGE = 10_000;
const ROLES: Role[] = ["EMPLOYEE", "MANAGER", "HR"];
const STATUS_LABELS: Record<EmployeeStatusFilter, string> = {
  active: "Activos",
  inactive: "Dados de baja",
  all: "Todos",
};
/** What an absent URL parameter means: the URL only carries what differs. */
const DEFAULTS: EmployeeFilters = { q: "", departmentId: "", role: "", status: "active", page: 1 };

/**
 * The filters live in the URL (shareable, and the browser's back button
 * restores them). Anything malformed falls back to the default, so a
 * hand-edited URL never breaks the page (the API validates again).
 */
function readFilters(params: URLSearchParams): EmployeeFilters {
  const role = params.get("role");
  const status = params.get("status");
  const page = Number(params.get("page"));
  const departmentId = params.get("departmentId") ?? "";
  return {
    q: (params.get("q") ?? "").slice(0, 100),
    // Same limits as the API (ids up to 64 characters, pages up to 10 000):
    // anything beyond falls back to the default instead of a 400.
    departmentId: departmentId.length <= 64 ? departmentId : "",
    role: role !== null && (ROLES as string[]).includes(role) ? (role as Role) : "",
    status: status === "inactive" || status === "all" ? status : "active",
    page: Number.isInteger(page) && page >= 1 && page <= MAX_PAGE ? page : 1,
  };
}

function writeFilters(filters: EmployeeFilters): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.q.trim() !== "") params.set("q", filters.q.trim());
  if (filters.departmentId !== "") params.set("departmentId", filters.departmentId);
  if (filters.role !== "") params.set("role", filters.role);
  if (filters.status !== DEFAULTS.status) params.set("status", filters.status);
  if (filters.page !== 1) params.set("page", String(filters.page));
  return params;
}

function EmployeeLink({ employee }: { employee: Employee }) {
  const location = useLocation();
  return (
    <Link
      to={employeeDetailPath(employee.id)}
      // The detail's "Volver" returns to this list with its filters.
      state={fromEmployeeListState(location.search)}
      className="font-medium underline-offset-4 hover:underline"
    >
      {employee.lastName}, {employee.firstName}
    </Link>
  );
}

function EmployeesTable({ employees }: { employees: Employee[] }) {
  return (
    <div className="hidden md:block">
      <Card className="py-0">
        <Table>
          <caption className="sr-only">Empleados</caption>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Nombre</TableHead>
              <TableHead scope="col">Rol</TableHead>
              <TableHead scope="col">Departamento</TableHead>
              <TableHead scope="col">Jefe directo</TableHead>
              <TableHead scope="col">Ingreso</TableHead>
              <TableHead scope="col">Estado</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {employees.map((employee) => (
              <TableRow key={employee.id}>
                <TableHead scope="row" className="font-normal text-foreground">
                  <span className="block">
                    <EmployeeLink employee={employee} />
                  </span>
                  <span className="text-xs break-all text-muted-foreground">{employee.email}</span>
                </TableHead>
                <TableCell>{ROLE_LABELS[employee.role]}</TableCell>
                <TableCell>{employee.department?.name ?? "—"}</TableCell>
                <TableCell>
                  {employee.manager ? `${employee.manager.firstName} ${employee.manager.lastName}` : "Sin jefe"}
                </TableCell>
                <TableCell className="whitespace-nowrap">{formatDate(employee.hireDate)}</TableCell>
                <TableCell>
                  <EmployeeStatusBadge isActive={employee.isActive} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}

function EmployeeCards({ employees }: { employees: Employee[] }) {
  return (
    <ul className="space-y-3 md:hidden" aria-label="Empleados">
      {employees.map((employee) => (
        <li key={employee.id}>
          <Card size="sm">
            <CardContent className="space-y-2">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <EmployeeLink employee={employee} />
                  <p className="text-xs break-all text-muted-foreground">{employee.email}</p>
                </div>
                <EmployeeStatusBadge isActive={employee.isActive} />
              </div>
              <dl className="grid grid-cols-2 gap-2 text-sm">
                <dt className="text-muted-foreground">Rol</dt>
                <dd>{ROLE_LABELS[employee.role]}</dd>
                <dt className="text-muted-foreground">Departamento</dt>
                <dd>{employee.department?.name ?? "—"}</dd>
                <dt className="text-muted-foreground">Jefe directo</dt>
                <dd>{employee.manager ? `${employee.manager.firstName} ${employee.manager.lastName}` : "Sin jefe"}</dd>
                <dt className="text-muted-foreground">Ingreso</dt>
                <dd>{formatDate(employee.hireDate)}</dd>
              </dl>
            </CardContent>
          </Card>
        </li>
      ))}
    </ul>
  );
}

/**
 * "Anterior"/"Siguiente": real links (they can open in a new tab), each a new
 * history entry. At the first/last page the SAME link stays mounted, only
 * marked aria-disabled: swapping it for another element would drop the
 * keyboard focus to <body> right after using it.
 */
function PageLink({ page, disabled, children }: { page: string; disabled: boolean; children: ReactNode }) {
  return (
    <Link
      to={page}
      aria-disabled={disabled || undefined}
      onClick={(event) => {
        if (disabled) event.preventDefault();
      }}
      className={cn(buttonVariants({ variant: "outline", size: "sm" }), disabled && "cursor-not-allowed opacity-50")}
    >
      {children}
    </Link>
  );
}

function Pagination({ filters, totalPages }: { filters: EmployeeFilters; totalPages: number }) {
  const linkTo = (page: number) => `?${writeFilters({ ...filters, page })}`;
  const isFirst = filters.page <= 1;
  const isLast = filters.page >= totalPages;
  return (
    <nav aria-label="Paginación de empleados" className="mt-4 flex items-center justify-between gap-2">
      <PageLink page={linkTo(isFirst ? 1 : Math.min(filters.page - 1, totalPages))} disabled={isFirst}>
        <ChevronLeft aria-hidden="true" />
        Anterior
      </PageLink>
      <p className="text-sm text-muted-foreground">
        Página {filters.page} de {totalPages}
      </p>
      <PageLink page={linkTo(isLast ? filters.page : filters.page + 1)} disabled={isLast}>
        Siguiente
        <ChevronRight aria-hidden="true" />
      </PageLink>
    </nav>
  );
}

function resultSummary(total: number, page: number, pageSize: number, shown: number): string {
  if (total === 0) return "Ningún empleado coincide con los filtros.";
  if (shown === 0) return `No hay resultados en esta página (hay ${total} en total).`;
  const from = (page - 1) * pageSize + 1;
  const to = from + shown - 1;
  return total === 1 ? "1 empleado." : `Mostrando ${from}–${to} de ${total} empleados.`;
}

export function EmployeesPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const filters = readFilters(searchParams);
  const employees = useEmployees(filters);
  const departments = useDepartments();
  const [status, setStatus] = useState<string | null>(null);
  const formDialog = useEntityDialog<EmployeeFormTarget>();
  const ids = { search: useId(), department: useId(), departmentError: useId(), role: useId(), status: useId() };

  // The search box is typed into locally and reaches the URL debounced, with
  // `replace`: typing never adds history entries (it replaces the current one,
  // so "back" skips the intermediate searches). When the URL changes by
  // navigation (back button, a shared link), the box follows it.
  const [draft, setDraft] = useState(filters.q);
  const settled = useDebouncedValue(draft, SEARCH_DEBOUNCE_MS);
  const lastWritten = useRef(filters.q);
  useEffect(() => {
    if (settled.trim() === filters.q.trim()) return;
    lastWritten.current = settled.trim();
    setSearchParams(writeFilters({ ...filters, q: settled, page: 1 }), { replace: true });
    // Only when the settled text changes; `filters` is read fresh from the URL.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settled]);
  useEffect(() => {
    if (filters.q !== lastWritten.current) {
      lastWritten.current = filters.q;
      setDraft(filters.q);
    }
  }, [filters.q]);

  /** A select changed: a new history entry, back to page 1. */
  const change = (patch: Partial<EmployeeFilters>) =>
    setSearchParams(writeFilters({ ...filters, q: draft, ...patch, page: 1 }));

  const data = employees.data;
  return (
    <>
      <PageHeading
        title="Empleados"
        description="Altas, bajas, jefes y contraseñas temporales. Cada cambio queda en la bitácora."
      />
      <AdminSubnav />
      <ActionStatus message={status} />
      <div className="mb-4 flex justify-end">
        <Button aria-haspopup="dialog" onClick={() => formDialog.show({ employee: null })}>
          Nuevo empleado
        </Button>
      </div>

      <search className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-label="Filtrar empleados">
        <div className="space-y-1.5 sm:col-span-2 lg:col-span-1">
          <Label htmlFor={ids.search}>Buscar</Label>
          <div className="relative">
            <Search
              className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              id={ids.search}
              type="search"
              className="pl-8"
              placeholder="Nombre o correo"
              value={draft}
              maxLength={100}
              onChange={(event) => setDraft(event.target.value)}
            />
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={ids.department}>Departamento</Label>
          <NativeSelect
            id={ids.department}
            className="w-full"
            value={filters.departmentId}
            onChange={(event) => change({ departmentId: event.target.value })}
            aria-describedby={departments.isError ? ids.departmentError : undefined}
          >
            <NativeSelectOption value="">Todos</NativeSelectOption>
            {/* The URL filters by a department not (yet) in the list: the select
                must not show "Todos" while the table IS filtered. */}
            {filters.departmentId !== "" && !departments.data?.some((department) => department.id === filters.departmentId) ? (
              <NativeSelectOption value={filters.departmentId}>
                {departments.isPending ? "Cargando…" : "Departamento seleccionado"}
              </NativeSelectOption>
            ) : null}
            {(departments.data ?? []).map((department) => (
              <NativeSelectOption key={department.id} value={department.id}>
                {department.name}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          {departments.isError ? (
            <p id={ids.departmentError} className="text-xs text-muted-foreground">
              No se pudieron cargar los departamentos.
            </p>
          ) : null}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={ids.role}>Rol</Label>
          <NativeSelect
            id={ids.role}
            className="w-full"
            value={filters.role}
            onChange={(event) => change({ role: event.target.value as Role | "" })}
          >
            <NativeSelectOption value="">Todos</NativeSelectOption>
            {ROLES.map((role) => (
              <NativeSelectOption key={role} value={role}>
                {ROLE_LABELS[role]}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={ids.status}>Estado</Label>
          <NativeSelect
            id={ids.status}
            className="w-full"
            value={filters.status}
            onChange={(event) => change({ status: event.target.value as EmployeeStatusFilter })}
          >
            {(Object.keys(STATUS_LABELS) as EmployeeStatusFilter[]).map((value) => (
              <NativeSelectOption key={value} value={value}>
                {STATUS_LABELS[value]}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
      </search>

      {employees.isPending ? (
        <LoadingBlock label="Cargando empleados…" />
      ) : employees.isError && !data ? (
        <QueryError
          title="No se pudieron cargar los empleados"
          error={employees.error}
          onRetry={() => void employees.refetch()}
          isRetrying={employees.isFetching}
        />
      ) : data ? (
        <>
          {employees.isError ? (
            // A refresh failed with data on screen: say it is old (and how to retry).
            <Alert role={undefined} className="mb-3">
              <TriangleAlert aria-hidden="true" />
              <AlertTitle>La lista puede estar desactualizada</AlertTitle>
              <AlertDescription>
                <p>No se pudo volver a cargar ({employees.error.message}).</p>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-2"
                  onClick={() => void employees.refetch()}
                  disabled={employees.isFetching}
                >
                  {employees.isFetching ? "Reintentando…" : "Reintentar"}
                </Button>
              </AlertDescription>
            </Alert>
          ) : null}
          {/* Announced when a search or a page change lands. */}
          <p role="status" className="mb-3 text-sm text-muted-foreground">
            {employees.isPlaceholderData ? "Buscando…" : resultSummary(data.total, data.page, data.pageSize, data.employees.length)}
          </p>
          {data.employees.length === 0 ? (
            <Card>
              <CardContent className="flex flex-col items-center gap-3 py-8 text-center">
                <Users className="size-10 text-muted-foreground" aria-hidden="true" />
                {data.total > 0 ? (
                  <Link to={`?${writeFilters({ ...filters, page: 1 })}`} className="text-sm underline underline-offset-4">
                    Ir a la primera página
                  </Link>
                ) : (
                  <p className="text-sm text-muted-foreground">Prueba con otra búsqueda u otros filtros.</p>
                )}
              </CardContent>
            </Card>
          ) : (
            <div className={cn(employees.isPlaceholderData && "opacity-60")}>
              <EmployeesTable employees={data.employees} />
              <EmployeeCards employees={data.employees} />
            </div>
          )}
          {data.totalPages > 1 ? <Pagination filters={filters} totalPages={data.totalPages} /> : null}
        </>
      ) : null}

      {formDialog.target ? (
        <EmployeeFormDialog
          key={formDialog.session}
          dialog={formDialog}
          employee={formDialog.target.employee}
          onDone={setStatus}
        />
      ) : null}
    </>
  );
}
