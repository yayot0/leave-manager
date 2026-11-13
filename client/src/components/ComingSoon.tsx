import { Construction } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { PageHeading } from "./PageHeading";

interface ComingSoonProps {
  title: string;
  description: string;
}

/** Placeholder page used until each section is built. */
export function ComingSoon({ title, description }: ComingSoonProps) {
  return (
    <>
      <PageHeading title={title} description={description} />
      <Card>
        <CardContent className="flex items-center gap-3 text-muted-foreground">
          <Construction className="size-5 shrink-0" aria-hidden="true" />
          <p>Esta sección estará disponible próximamente.</p>
        </CardContent>
      </Card>
    </>
  );
}
