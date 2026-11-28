import { eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import { horarioInicial, MARGEN_HORARIO_MS, turnosCopias, type HorarioCopias } from "@/lib/copias-horario";

function instanciaId() {
  return process.env.COPIAS_INSTANCIA_ID || "";
}

export async function leerProgramacion(organizationId: string) {
  const id = instanciaId();
  const db = getDb();
  const [fila] = id
    ? await db.select({ horario: schema.copiaProgramacion, estado: schema.copiaEstado })
      .from(schema.copiaEstado)
      .leftJoin(schema.copiaProgramacion, scoped(schema.copiaProgramacion.organizationId, organizationId,
        eq(schema.copiaProgramacion.instanciaId, id)))
      .where(scoped(schema.copiaEstado.organizationId, organizationId, eq(schema.copiaEstado.instanciaId, id)))
      .limit(1)
    : [];
  const horario: HorarioCopias = fila?.horario ?? horarioInicial;
  const ahora = new Date();
  const estado = fila?.estado;
  const conectado = !!estado && ahora.getTime() - estado.contacto.getTime() < MARGEN_HORARIO_MS;
  return {
    horario: { habilitada: horario.habilitada, frecuencia: horario.frecuencia, horaUtc: horario.horaUtc, dia: horario.dia },
    conectado,
    ultimoContacto: estado?.contacto?.toISOString() ?? null,
    siguiente: conectado && horario.habilitada ? turnosCopias(horario, ahora).siguiente.toISOString() : null,
    ultimaVerificada: estado?.ultimaVerificada?.toISOString() ?? null,
    resultado: estado?.resultado ?? null,
  };
}

export async function guardarProgramacion(organizationId: string, horario: HorarioCopias) {
  const id = instanciaId();
  if (!id) return false;
  const actual = await leerProgramacion(organizationId);
  if (horario.habilitada && !actual.conectado) return false;
  await getDb().insert(schema.copiaProgramacion)
    .values({ organizationId, instanciaId: id, ...horario, desde: new Date() })
    .onConflictDoUpdate({
      target: [schema.copiaProgramacion.organizationId, schema.copiaProgramacion.instanciaId],
      set: { ...horario, desde: new Date() },
    });
  return true;
}
