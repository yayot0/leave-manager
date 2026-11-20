import { useEffect, useId, useRef, useState } from "react";
import { Building2 } from "lucide-react";
import type { Department } from "@/api/types";
import { useDeleteDepartment, useDepartments, useSaveDepartment } from "@/hooks/hr";
import { useEntityDialog, type EntityDialog } from "@/hooks/use-entity-dialog";
import { ActionStatus } from "@/components/admin/ActionStatus";
import { AdminSubnav } from "@/components/admin/AdminSubnav";
import { CatalogFormDialog, FieldError } from "@/components/admin/CatalogFormDialog";
import { catalogFormError, fieldErrorProps } from "@/components/admin/catalog-errors";
import { ConfirmActionDialog } from "@/components/admin/ConfirmActionDialog";
import { PageHeading } from "@/components/PageHeading";
import { LoadingBlock, QueryError } from "@/components/QueryStatus";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

const NAME_MAX = 60;

/** Same limits as the API (2–60 characters after trimming); the API re-checks. */
function validateName(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed.length < 2) return "Escribe un nombre de al menos 2 caracteres.";
  if (trimmed.length > NAME_MAX) return `El nombre no puede exceder ${NAME_MAX} caracteres.`;
  return null;
}

function employeesLabel(count: number): string {
  return count === 1 ? "1 empleado" : `${count} empleados`;
}

type OnDone = (message: string) => void;

/** What the form dialog was opened for: a new department, or renaming one. */
type FormTarget = { department: Department | null };

/** Create (department null) or rename. Mounted once per opening (`key={session}`). */
function DepartmentFormDialog({
  dialog,
  department,
  onDone,
}: {
  dialog: EntityDialog<FormTarget>;
  department: Department | null;
  onDone: OnDone;
}) {
  const mutation = useSaveDepartment(department?.id);
  const [name, setName] = useState(department?.name ?? "");
  const [nameError, setNameError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const nameId = useId();
  const errorId = useId();

  const apiError = catalogFormError(mutation.error);
  const shownNameError = nameError ?? (apiError?.field === "name" ? apiError.message : null);

  // A field error from the API (e.g. a duplicate name): focus that field once
  // it is enabled again (the input was disabled while saving).
  useEffect(() => {
    if (apiError?.field === "name") nameRef.current?.focus();
  }, [apiError?.field, mutation.error]);

  return (
    <CatalogFormDialog
      open={dialog.open}
      setOpen={dialog.setOpen}
      finalFocus={dialog.finalFocus}
      title={department ? `Renombrar ${department.name}` : "Nuevo departamento"}
      submitLabel={department ? "Guardar" : "Crear departamento"}
      pendingLabel="Guardando…"
      isPending={mutation.isPending}
      locked={apiError?.locked}
      generalError={apiError && apiError.field === null ? apiError : null}
      initialFocus={nameRef}
      onSubmit={(close) => {
        const error = validateName(name);
        if (error) {
          setNameError(error);
          nameRef.current?.focus();
          return;
        }
        const trimmed = name.trim();
        mutation.mutate(trimmed, {
          onSuccess: () => {
            close();
            onDone(department ? `Departamento renombrado a "${trimmed}".` : `Departamento "${trimmed}" creado.`);
          },
        });
      }}
    >
      <div className="space-y-2">
        <Label htmlFor={nameId}>Nombre</Label>
        <Input
          ref={nameRef}
          id={nameId}
          value={name}
          maxLength={NAME_MAX}
          required
          disabled={mutation.isPending}
          onChange={(event) => {
            setName(event.target.value);
            setNameError(null);
          }}
          {...fieldErrorProps(shownNameError, errorId)}
        />
        <FieldError id={errorId} message={shownNameError} />
      </div>
    </CatalogFormDialog>
  );
}

function DeleteDepartmentDialog({
  dialog,
  department,
  onDone,
}: {
  dialog: EntityDialog<Department>;
  department: Department;
  onDone: OnDone;
}) {
  const remove = useDeleteDepartment();
  const hasEmployees = department.employeeCount > 0;
  return (
    <ConfirmActionDialog
      open={dialog.open}
      setOpen={dialog.setOpen}
      finalFocus={dialog.finalFocus}
      title={hasEmployees ? `No se puede borrar ${department.name}` : `¿Borrar ${department.name}?`}
      description={
        hasEmployees
          ? `Tiene ${employeesLabel(department.employeeCount)} (contando inactivos). Reasígnalos a otro departamento antes de borrarlo.`
          : "El departamento no tiene empleados. Quedará registrado en la bitácora de cambios."
      }
      confirmLabel="Sí, borrar"
      pendingLabel="Borrando…"
      destructive
      canConfirm={!hasEmployees}
      action={{
        isPending: remove.isPending,
        error: remove.error,
        run: (callbacks) => remove.mutate(department.id, callbacks),
      }}
      onRemoved={dialog.markRemoved}
      onDone={() => onDone(`Departamento "${department.name}" borrado.`)}
    />
  );
}

interface RowActionsProps {
  department: Department;
  onRename: (department: Department) => void;
  onDelete: (department: Department) => void;
}

/** Only buttons: the dialogs live at page level (see useEntityDialog). */
function RowActions({ department, onRename, onDelete }: RowActionsProps) {
  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      <Button
        variant="outline"
        size="sm"
        aria-haspopup="dialog"
        aria-label={`Renombrar ${department.name}`}
        onClick={() => onRename(department)}
      >
        Renombrar
      </Button>
      <Button
        variant="outline"
        size="sm"
        aria-haspopup="dialog"
        aria-label={`Borrar ${department.name}`}
        onClick={() => onDelete(department)}
      >
        Borrar
      </Button>
    </div>
  );
}

type ListProps = Omit<RowActionsProps, "department"> & { departments: Department[] };

function DepartmentsTable({ departments, ...actions }: ListProps) {
  return (
    <div className="hidden md:block">
      <Card className="py-0">
        <Table>
          <caption className="sr-only">Departamentos</caption>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Nombre</TableHead>
              <TableHead scope="col" className="text-right">
                Empleados
              </TableHead>
              <TableHead scope="col" className="text-right">
                <span className="sr-only">Acciones</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {departments.map((department) => (
              <TableRow key={department.id}>
                {/* Row header: moving across cells, a screen reader says "Ventas, Empleados, 3". */}
                <TableHead scope="row" className="font-medium text-foreground">
                  {department.name}
                </TableHead>
                <TableCell className="text-right tabular-nums">{department.employeeCount}</TableCell>
                <TableCell>
                  <RowActions department={department} {...actions} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}

function DepartmentCards({ departments, ...actions }: ListProps) {
  return (
    <ul className="space-y-3 md:hidden" aria-label="Departamentos">
      {departments.map((department) => (
        <li key={department.id}>
          <Card size="sm">
            <CardContent className="space-y-3">
              <div>
                <p className="font-medium">{department.name}</p>
                <p className="text-sm text-muted-foreground">{employeesLabel(department.employeeCount)}</p>
              </div>
              <RowActions department={department} {...actions} />
            </CardContent>
          </Card>
        </li>
      ))}
    </ul>
  );
}

function EmptyState() {
  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-3 py-8 text-center">
        <Building2 className="size-10 text-muted-foreground" aria-hidden="true" />
        <div className="space-y-1">
          <h2 className="font-semibold">Aún no hay departamentos</h2>
          <p className="text-sm text-muted-foreground">Crea el primero para poder asignarlo a los empleados.</p>
        </div>
      </CardContent>
    </Card>
  );
}

export function DepartmentsPage() {
  const departments = useDepartments();
  const [status, setStatus] = useState<string | null>(null);
  const formDialog = useEntityDialog<FormTarget>();
  const deleteDialog = useEntityDialog<Department>();
  const actions = {
    onRename: (department: Department) => formDialog.show({ department }),
    onDelete: (department: Department) => deleteDialog.show(department),
  };

  return (
    <>
      <PageHeading title="Departamentos" description="Áreas de la empresa a las que pertenecen los empleados." />
      <AdminSubnav />
      <ActionStatus message={status} />
      <div className="mb-4 flex justify-end">
        <Button aria-haspopup="dialog" onClick={() => formDialog.show({ department: null })}>
          Nuevo departamento
        </Button>
      </div>
      {departments.isPending ? (
        <LoadingBlock label="Cargando departamentos…" />
      ) : departments.isError ? (
        <QueryError
          title="No se pudieron cargar los departamentos"
          error={departments.error}
          onRetry={() => void departments.refetch()}
          isRetrying={departments.isFetching}
        />
      ) : departments.data.length === 0 ? (
        <EmptyState />
      ) : (
        <>
          <DepartmentsTable departments={departments.data} {...actions} />
          <DepartmentCards departments={departments.data} {...actions} />
        </>
      )}

      {/* Page-level dialogs: they survive their row disappearing behind them. */}
      {formDialog.target ? (
        <DepartmentFormDialog
          key={formDialog.session}
          dialog={formDialog}
          department={formDialog.target.department}
          onDone={setStatus}
        />
      ) : null}
      {deleteDialog.target ? (
        <DeleteDepartmentDialog
          key={deleteDialog.session}
          dialog={deleteDialog}
          department={deleteDialog.target}
          onDone={setStatus}
        />
      ) : null}
    </>
  );
}
