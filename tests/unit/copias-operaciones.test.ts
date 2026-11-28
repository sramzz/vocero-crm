import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const doble = vi.hoisted(() => ({
  descubrir: vi.fn(), docker: vi.fn(), listar: vi.fn(), subir: vi.fn(), descargar: vi.fn(), quitar: vi.fn(),
}));
vi.mock("../../scripts/copias/infra.mjs", async (original) => {
  const real = await original<typeof import("../../scripts/copias/infra.mjs")>();
  return {
    ...real,
    ...doble,
    comprobarDespliegue: vi.fn(async () => {}),
    comprobarRevision: async () => "a".repeat(40),
    contenedores: async () => [],
    ligados: async () => "bucket",
    subirParte: doble.subir,
    objetos: async (s: { bucket: string }) => [...bytesRemotos]
      .filter(([key]) => key.startsWith(`${s.bucket}/`))
      .map(([key, data]) => ({ Key: key.slice(s.bucket.length + 1), Size: data.byteLength, ETag: JSON.stringify(data.toString("hex")) })),
  };
});

import { backup, certificar, mediaMigrate, restore } from "../../scripts/copias/operaciones.mjs";

let base: string;
let run = true;
let bytesRemotos: Map<string, Buffer>;
let ruta: string;
let ctx: {
  base: string;
  uuid: string;
  cfg: { medios: { bucket: string; endpoint: string }; revision: string; huellaClave: string; referenciaClave: string; organizacion: string; dumpUsuario: string; destinoPrueba: boolean };
  config: { archivo: { bucket: string }; instancias: Record<string, { destinoPrueba: boolean }> };
};
const señal = new AbortController().signal;
const mediaId = "org/asset";
const claveRemota = `medios/${mediaId}`;

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "vocero-copias-prueba-")));
  ruta = join(base, "datos", "media", mediaId);
  await mkdir(join(base, "datos", "media", "org"), { recursive: true });
  await writeFile(ruta, "archivo-original");
  bytesRemotos = new Map();
  run = true;
  vi.resetAllMocks();
  doble.descubrir.mockImplementation(async () => ({
    servicios: { app: { Id: "a".repeat(64), State: { Running: run } },
      nea: { Id: "b".repeat(64), State: { Running: false } }, postgres: { Id: "c".repeat(64) } },
    datos: join(base, "datos"),
  }));
  doble.listar.mockImplementation(async (s, prefijo) => [...bytesRemotos.keys()]
    .filter((key) => key.startsWith(`${s.bucket}/${prefijo}`)).map((key) => key.slice(s.bucket.length + 1)));
  doble.subir.mockImplementation(async (s, k, p) => {
    const key = `${s.bucket}/${k}`;
    if (bytesRemotos.has(key)) throw new Error("Ya existe");
    if (s.bucket === "archivo") expect(run).toBe(true);
    bytesRemotos.set(key, await readFile(p));
  });
  doble.descargar.mockImplementation(async (s, k, p) => {
    const data = bytesRemotos.get(`${s.bucket}/${k}`);
    if (!data) throw new Error("Objeto ausente");
    await writeFile(p, data);
    return JSON.stringify({ ContentType: "image/png", ETag: JSON.stringify(data.toString("hex")) });
  });
  doble.quitar.mockImplementation(async (s, key) => bytesRemotos.delete(`${s.bucket}/${key}`));
  doble.docker.mockImplementation(async (args: string[], opts = {}) => {
    const salida = (opts as { salida?: string }).salida;
    if (args[0] === "stop") run = false;
    if (args[0] === "start") run = true;
    if (args[0] === "inspect") return JSON.stringify([{ State: { Running: run } }]);
    if (args.includes("pg_dump") && salida) await writeFile(salida, "dump de prueba");
    if (args.includes("-f")) return JSON.stringify([{ key: mediaId, tipo: "image/png" }]);
    return args.includes("psql") ? "1000\n" : "";
  });
  ctx = { base, uuid: "instancia", cfg: { medios: { bucket: "medios", endpoint: "https://s3.example" }, revision: "a".repeat(40),
    huellaClave: "b".repeat(64), referenciaClave: "clave-1", organizacion: "org", dumpUsuario: "postgres", destinoPrueba: false },
  config: { archivo: { bucket: "archivo" }, instancias: { prueba: { destinoPrueba: true } } } };
});

afterEach(async () => { await rm(base, { recursive: true, force: true }); });

describe("067 — operación de copias y medios", () => {
  it("reanuda los escritores si falla la captura y no publica el conjunto", async () => {
    const dockerNormal = doble.docker.getMockImplementation()!;
    doble.docker.mockImplementation((args: string[], opts) => {
      if (args.includes("pg_dump")) throw new Error("Fallo simulado");
      return dockerNormal(args, opts);
    });
    await expect(backup(ctx, señal)).rejects.toThrow("Fallo simulado");
    expect(run).toBe(true);
    expect([...bytesRemotos]).toEqual([]);
    expect((await readdir(base)).some((name) => name.endsWith("reanudacion.json"))).toBe(false);
  });

  it("prepara objetos con escritores activos y evita descargarlos de nuevo durante la pausa", async () => {
    bytesRemotos.set(claveRemota, Buffer.from("estaba-en-bucket"));
    const descargarNormal = doble.descargar.getMockImplementation()!;
    const estados: boolean[] = [];
    doble.descargar.mockImplementation((s, k, p, signal, etag) => {
      if (s.bucket === "medios" && k === mediaId) estados.push(run);
      return descargarNormal(s, k, p, signal, etag);
    });
    await expect(backup(ctx, señal)).resolves.toHaveProperty("id");
    expect(estados).toEqual([true]);
    expect(run).toBe(true);
  });

  it("una subida interrumpida conserva el conjunto completo anterior", async () => {
    const anterior = await backup(ctx, señal);
    const escribir = doble.subir.getMockImplementation()!;
    doble.subir.mockImplementation((s, key, ruta) => {
      if (s.bucket === "archivo" && key.endsWith("/datos.tar")) throw new Error("Transferencia interrumpida");
      return escribir(s, key, ruta);
    });
    await expect(backup(ctx, señal)).rejects.toThrow("Transferencia interrumpida");
    const publicados = [...bytesRemotos.keys()].filter((key) => key.endsWith("manifiesto.json"));
    expect(publicados).toEqual([`archivo/instancia/${anterior.id}/manifiesto.json`]);
    expect(run).toBe(true);
  });

  it("solo quita la copia local verificada y certificada", async () => {
    const respaldo = await backup(ctx, señal);
    expect([...bytesRemotos.keys()].at(-1)).toContain("manifiesto.json");
    const traslado = await mediaMigrate(ctx, "copy", undefined, respaldo.id, señal);
    expect(traslado).toHaveProperty("verificados", 1);
    if (!("id" in traslado)) throw new Error("Falta el manifiesto.");
    const id = traslado.id;
    expect(bytesRemotos.get(claveRemota)?.toString()).toBe("archivo-original");
    expect(await readFile(ruta, "utf8")).toBe("archivo-original");
    await expect(mediaMigrate(ctx, "prune", id, undefined, señal)).rejects.toThrow("Certifica");
    const descubrirOrigen = doble.descubrir.getMockImplementation()!;
    const destino = join(base, "aislado");
    await mkdir(destino);
    doble.descubrir.mockImplementation((uuid) => uuid === "prueba" ? {
      servicios: {
        app: { Id: "d".repeat(64), State: { Running: false }, NetworkSettings: { Networks: { aislada: {} } },
          HostConfig: { PortBindings: {} } },
        nea: { Id: "e".repeat(64), State: { Running: false }, NetworkSettings: { Networks: { aislada: {} } }, HostConfig: {} },
        postgres: { Id: "f".repeat(64), NetworkSettings: { Networks: { aislada: {} } }, HostConfig: {} },
      },
      datos: destino, pgDatos: join(base, "pg-aislado"), proyecto: "aislado", volumenes: ["datos-aislados", "pg-aislado"],
    } : descubrirOrigen(uuid).then((r: object) => ({
      ...r, pgDatos: join(base, "pg"),
      servicios: { ...((r as { servicios: object }).servicios),
        app: { NetworkSettings: { Networks: { origen: {} } } } },
    })));
    const dockerOrigen = doble.docker.getMockImplementation()!;
    doble.docker.mockImplementation(async (args, opts) => {
      if (args[0] === "network") return JSON.stringify([{ Name: "aislada", Internal: true, Labels: { "com.docker.compose.project": "aislado" } }]);
      if (args.includes("pg_restore")) return "";
      if (args.includes("psql") && args.includes("f".repeat(64))) return "0\n0\n0";
      return dockerOrigen(args, opts);
    });
    const prueba = { ...ctx, uuid: "prueba", cfg: { ...ctx.cfg, destinoPrueba: true, medios: { ...ctx.cfg.medios, bucket: "medios-aislados" } },
      config: { ...ctx.config, instancias: { ...ctx.config.instancias, instancia: { destinoPrueba: false } } } };
    await expect(restore(prueba, "instancia", respaldo.id, señal)).resolves.toHaveProperty("estado", "restaurada_pendiente_de_verificar");
    expect(await readFile(join(destino, "media", mediaId), "utf8")).toBe("archivo-original");
    await certificar(prueba, "instancia", respaldo.id);
    doble.descubrir.mockImplementation(descubrirOrigen);
    doble.docker.mockImplementation(dockerOrigen);
    bytesRemotos.set(claveRemota, Buffer.from("copia-alterada"));
    await expect(mediaMigrate(ctx, "prune", id, undefined, señal)).rejects.toThrow("copia remota");
    expect(await readFile(ruta, "utf8")).toBe("archivo-original");
    bytesRemotos.set(claveRemota, Buffer.from("archivo-original"));
    await expect(mediaMigrate(ctx, "prune", id, undefined, señal)).resolves.toEqual({ id, eliminados: 1 });
    await expect(readFile(ruta)).rejects.toMatchObject({ code: "ENOENT" });
    expect(bytesRemotos.get(claveRemota)?.toString()).toBe("archivo-original");
    expect(run).toBe(true);
  });
});
