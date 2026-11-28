import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sesion: { userId: "user", organizationId: "org_activa", role: "owner" },
  leer: vi.fn(),
  guardar: vi.fn(),
}));
vi.mock("@/lib/auth/session", () => ({ requireSession: async () => mocks.sesion }));
vi.mock("@/lib/env", () => ({ getEnv: () => ({ APP_BASE_URL: "https://vocero.example" }) }));
vi.mock("@/server/copias/programacion", () => ({ leerProgramacion: mocks.leer, guardarProgramacion: mocks.guardar }));
import { GET, PUT } from "@/app/api/settings/backups/route";
import { horarioInicial } from "@/lib/copias-horario";

function peticion(body: unknown, origin = "https://vocero.example") {
  return new Request("https://vocero.example/api/settings/backups", {
    method: "PUT", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
}

describe("067 — permisos de programación", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.sesion.role = "owner";
    mocks.leer.mockResolvedValue({ conectado: true, horario: horarioInicial });
    mocks.guardar.mockResolvedValue(true);
  });
  it("impide lecturas y cambios por miembros", async () => {
    mocks.sesion.role = "member";
    expect((await GET()).status).toBe(403);
    expect((await PUT(peticion(horarioInicial))).status).toBe(403);
    expect(mocks.leer).not.toHaveBeenCalled();
    expect(mocks.guardar).not.toHaveBeenCalled();
  });
  it("rechaza orígenes externos e intentos de escoger otra organización", async () => {
    expect((await PUT(peticion(horarioInicial, "https://otra.example"))).status).toBe(403);
    expect((await PUT(peticion({ ...horarioInicial, organizationId: "otra" }))).status).toBe(422);
    expect(mocks.guardar).not.toHaveBeenCalled();
  });
  it("permite cambiar el horario usando la organización de la sesión", async () => {
    mocks.sesion.role = "admin";
    expect((await PUT(peticion(horarioInicial))).status).toBe(200);
    expect(mocks.guardar).toHaveBeenCalledWith("org_activa", horarioInicial);
  });
  it("informa cuando el ejecutor está desconectado", async () => {
    mocks.guardar.mockResolvedValue(false);
    const r = await PUT(peticion({ ...horarioInicial, habilitada: true }));
    expect(r.status).toBe(409);
    expect((await r.json()).error.code).toBe("ejecutor_desconectado");
  });
});
