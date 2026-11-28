import { z } from "zod";

export const frecuenciasCopias = ["8h", "12h", "diaria", "semanal"] as const;
export const horarioCopiasSchema = z.object({
  habilitada: z.boolean(),
  frecuencia: z.enum(frecuenciasCopias),
  horaUtc: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
  dia: z.number().int().min(0).max(6).nullable(),
}).strict().refine((h) => (h.frecuencia === "semanal") === (h.dia !== null), {
  path: ["dia"],
  message: "Selecciona un día solo para la frecuencia semanal.",
});

export type HorarioCopias = z.infer<typeof horarioCopiasSchema>;
export const horarioInicial: HorarioCopias = { habilitada: false, frecuencia: "8h", horaUtc: "08:00", dia: null };
export const MARGEN_HORARIO_MS = 5 * 60_000;
const horaMs = 3_600_000;

/** Los timestamps de dominio no llevan zona en PostgreSQL y representan UTC. */
export function timestampCopiasUtc(valor: string): Date {
  return new Date(`${valor.replace(" ", "T")}Z`);
}

export function intervaloCopias(h: HorarioCopias): number {
  return { "8h": 8, "12h": 12, diaria: 24, semanal: 168 }[h.frecuencia] * horaMs;
}

/** Par de turnos que rodea al instante en UTC, incluso al cruzar medianoche. */
export function turnosCopias(h: HorarioCopias, ahora: Date) {
  const [hora = 0, minuto = 0] = h.horaUtc.split(":").map(Number);
  const ancla = Date.UTC(1970, 0, h.frecuencia === "semanal" ? 4 + (h.dia ?? 0) : 1, hora, minuto);
  const intervalo = intervaloCopias(h);
  const turno = ancla + Math.floor((ahora.getTime() - ancla) / intervalo) * intervalo;
  return { anterior: new Date(turno), siguiente: new Date(turno + intervalo) };
}
