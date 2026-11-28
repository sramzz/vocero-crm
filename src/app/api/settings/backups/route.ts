import { apiError, parseBody, withAuth } from "@/lib/api";
import { canConfigure } from "@/lib/auth/roles";
import { horarioCopiasSchema } from "@/lib/copias-horario";
import { getEnv } from "@/lib/env";
import { guardarProgramacion, leerProgramacion } from "@/server/copias/programacion";

export const dynamic = "force-dynamic";

export const GET = withAuth(async (session) => {
  if (!canConfigure(session.role)) return apiError(403, "forbidden", "Se requiere permiso de configuración.");
  return Response.json(await leerProgramacion(session.organizationId), { headers: { "Cache-Control": "no-store" } });
});

export const PUT = withAuth(async (session, req: Request) => {
  if (!canConfigure(session.role)) return apiError(403, "forbidden", "Se requiere permiso de configuración.");
  if (req.headers.get("origin") !== new URL(getEnv().APP_BASE_URL).origin) {
    return apiError(403, "invalid_origin", "Origen no autorizado.");
  }
  const body = await parseBody(req, horarioCopiasSchema);
  if (!body.ok) return body.response;
  if (!await guardarProgramacion(session.organizationId, body.data)) {
    return apiError(409, "ejecutor_desconectado", "Configura el ejecutor de copias antes de habilitar la programación.");
  }
  return Response.json(await leerProgramacion(session.organizationId));
});
