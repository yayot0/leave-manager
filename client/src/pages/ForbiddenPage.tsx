import { Link } from "react-router";
import { buttonVariants } from "@/components/ui/button";
import { PageHeading } from "@/components/PageHeading";
import { HOME_ROUTE, homeLabel } from "@/app/navigation";

export function ForbiddenPage() {
  return (
    <>
      <PageHeading
        title="No tienes acceso a esta sección"
        description="Tu rol no permite ver esta página. Si crees que es un error, contacta a Recursos Humanos."
      />
      <Link to={HOME_ROUTE} className={buttonVariants({ variant: "outline" })}>
        Ir a {homeLabel()}
      </Link>
    </>
  );
}
