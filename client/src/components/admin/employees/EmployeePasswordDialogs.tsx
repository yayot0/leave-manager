import { TriangleAlert } from "lucide-react";
import type { EmployeeDetail, Role } from "@/api/types";
import { ROLE_LABELS } from "@/app/navigation";
import { useReactivateEmployee, useResetEmployeePassword } from "@/hooks/hr";
import type { EntityDialog } from "@/hooks/use-entity-dialog";
import { PasswordActionDialog } from "@/components/admin/employees/PasswordActionDialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { isPrivilegedRole, powersOf, privilegedAcknowledgement } from "./privileged";

/**
 * Restablecer and Reactivar. Each dialog OWNS its mutation and is mounted
 * once per opening (`key={session}`): a new opening starts without the
 * previous error (and can retry after a STALE_DATA). Everything comes from
 * `employee`, the snapshot taken when the dialog opened (dialog.target), not
 * from the live detail: a refresh behind the dialog must not change the
 * updatedAt that is sent or the warning that HR is confirming.
 */

export function PasswordWarning({ role, firstName }: { role: Role; firstName: string }) {
  const privileged = isPrivilegedRole(role);
  return (
    // A fixed notice, not the result of an action.
    <Alert role={undefined} variant={privileged ? "destructive" : "default"}>
      <TriangleAlert aria-hidden="true" />
      <AlertTitle>
        {privileged ? `Cuidado: es una cuenta de ${ROLE_LABELS[role]}` : "Verás la contraseña temporal"}
      </AlertTitle>
      <AlertDescription>
        <p>Entrégala solo a {firstName}, en persona o por un canal privado.</p>
        {privileged ? (
          <p>
            Hasta que la cambie, quien la conozca puede entrar como {firstName} y {powersOf(role)}: todo quedaría
            registrado a su nombre, no al tuyo.
          </p>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}

interface DialogProps {
  dialog: EntityDialog<EmployeeDetail>;
  employee: EmployeeDetail;
  onDone: (message: string) => void;
}

export function ResetPasswordDialog({ dialog, employee, onDone }: DialogProps) {
  const reset = useResetEmployeePassword(employee.id);
  const fullName = `${employee.firstName} ${employee.lastName}`;
  return (
    <PasswordActionDialog
      dialog={dialog}
      title={`¿Restablecer la contraseña de ${fullName}?`}
      description="Se generará una contraseña temporal, se cerrarán todas sus sesiones y su contraseña actual dejará de funcionar."
      acknowledgement={privilegedAcknowledgement(employee.role, employee.firstName)}
      confirmLabel="Sí, restablecer"
      pendingLabel="Restableciendo…"
      destructive
      revealTitle={`Contraseña temporal de ${fullName}`}
      personName={fullName}
      action={{
        isPending: reset.isPending,
        error: reset.error,
        run: (onSuccess) =>
          reset.mutate(undefined, {
            onSuccess: (result) => {
              onSuccess(result.temporaryPassword);
              // Only the dialog keeps it now (gcTime 0 drops it from the cache).
              reset.reset();
            },
          }),
      }}
      onDone={() => onDone(`Contraseña de ${fullName} restablecida; sus sesiones se cerraron.`)}
    >
      <PasswordWarning role={employee.role} firstName={employee.firstName} />
    </PasswordActionDialog>
  );
}

export function ReactivateEmployeeDialog({ dialog, employee, onDone }: DialogProps) {
  const reactivate = useReactivateEmployee(employee.id);
  const fullName = `${employee.firstName} ${employee.lastName}`;
  return (
    <PasswordActionDialog
      dialog={dialog}
      title={`¿Reactivar a ${fullName}?`}
      description="Podrá volver a iniciar sesión con una contraseña temporal nueva (la anterior pudo quedar comprometida)."
      acknowledgement={privilegedAcknowledgement(employee.role, employee.firstName)}
      confirmLabel="Sí, reactivar"
      pendingLabel="Reactivando…"
      revealTitle={`${fullName} está activo de nuevo`}
      personName={fullName}
      action={{
        isPending: reactivate.isPending,
        error: reactivate.error,
        run: (onSuccess) =>
          // The updatedAt HR saw when opening the dialog (optimistic concurrency).
          reactivate.mutate(employee.updatedAt, {
            onSuccess: (result) => {
              onSuccess(result.temporaryPassword);
              reactivate.reset();
            },
          }),
      }}
      onDone={() => onDone(`${fullName} fue reactivado.`)}
    >
      <PasswordWarning role={employee.role} firstName={employee.firstName} />
    </PasswordActionDialog>
  );
}
