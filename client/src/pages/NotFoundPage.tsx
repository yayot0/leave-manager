import { Link } from "react-router";
import { buttonVariants } from "@/components/ui/button";
import { PageHeading } from "@/components/PageHeading";
import { HOME_ROUTE, homeLabel } from "@/app/navigation";

export function NotFoundPage() {
  return (
    <>
      <PageHeading title="Página no encontrada" description="La dirección que buscas no existe." />
      <Link to={HOME_ROUTE} className={buttonVariants({ variant: "outline" })}>
        Ir a {homeLabel()}
      </Link>
    </>
  );
}
