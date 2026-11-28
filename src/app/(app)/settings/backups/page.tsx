import { notFound } from "next/navigation";
import { CopiasClient } from "@/components/settings/copias-client";
import { canConfigure } from "@/lib/auth/roles";
import { getSessionOrNull } from "@/lib/auth/session";
import { leerProgramacion } from "@/server/copias/programacion";

export default async function CopiasPage() {
  const sesion = await getSessionOrNull();
  if (!sesion || !canConfigure(sesion.role)) notFound();
  return <CopiasClient inicial={await leerProgramacion(sesion.organizationId)} />;
}
