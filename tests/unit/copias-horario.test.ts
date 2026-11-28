import { describe, expect, it, vi } from "vitest";
import { horarioCopiasSchema, horarioInicial, intervaloCopias, timestampCopiasUtc, turnosCopias } from "@/lib/copias-horario";

describe("067 — horario de copias", () => {
  it("propone tres turnos UTC cada día y arranca deshabilitado", () => {
    expect(horarioInicial.habilitada).toBe(false);
    const a = turnosCopias(horarioInicial, new Date("2026-11-28T00:00:00Z"));
    const b = turnosCopias(horarioInicial, a.siguiente);
    const c = turnosCopias(horarioInicial, b.siguiente);
    expect([a.anterior, b.anterior, c.anterior, c.siguiente].map((x) => x.toISOString())).toEqual([
      "2026-11-28T00:00:00.000Z", "2026-11-28T08:00:00.000Z",
      "2026-11-28T16:00:00.000Z", "2026-11-29T00:00:00.000Z",
    ]);
    expect(intervaloCopias(horarioInicial)).toBe(8 * 3_600_000);
  });

  it("conserva los minutos al cruzar medianoche y maneja la semana UTC", () => {
    const a = turnosCopias({ ...horarioInicial, horaUtc: "21:15" }, new Date("2026-11-28T23:59:00Z"));
    expect(a.siguiente.toISOString()).toBe("2026-11-29T05:15:00.000Z");
    const b = turnosCopias({ ...horarioInicial, frecuencia: "semanal", dia: 1 }, new Date("2026-11-29T22:00:00Z"));
    expect(b.siguiente.toISOString()).toBe("2026-11-30T08:00:00.000Z");
  });

  it("lee la hora de PostgreSQL en UTC aunque el host use otra zona", () => {
    vi.stubEnv("TZ", "America/Bogota");
    try {
      expect(timestampCopiasUtc("2026-11-28 08:00:00.125").toISOString()).toBe("2026-11-28T08:00:00.125Z");
    } finally { vi.unstubAllEnvs(); }
  });

  it("rechaza horarios, días y claves adicionales fuera del contrato", () => {
    expect(horarioCopiasSchema.safeParse({ ...horarioInicial, horaUtc: "24:00" }).success).toBe(false);
    expect(horarioCopiasSchema.safeParse({ ...horarioInicial, frecuencia: "semanal" }).success).toBe(false);
    expect(horarioCopiasSchema.safeParse({ ...horarioInicial, dia: 1 }).success).toBe(false);
    expect(horarioCopiasSchema.safeParse({ ...horarioInicial, instanciaId: "otra" }).success).toBe(false);
  });
});
