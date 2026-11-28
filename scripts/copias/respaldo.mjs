import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { coincide, comprobarEspacio, comprobarSeparacion, configBucket, ejecutar, huella, s3, uri } from "./almacen.mjs";

export async function temporal(operacion) {
  const dir = await mkdtemp(join(tmpdir(), "vocero-copias-"));
  try {
    return await operacion(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function conexionPostgres() {
  const url = URL.parse(process.env.DATABASE_URL ?? "");
  if (!url || !["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname
    || !url.username || !/^\/[^/]+$/.test(url.pathname) || url.hash) {
    throw new Error("DATABASE_URL debe apuntar a PostgreSQL por TCP.");
  }
  const sslmode = url.searchParams.get("sslmode") || "prefer";
  if ([...url.searchParams.keys()].some((nombre) => nombre !== "sslmode")
    || !["disable", "allow", "prefer", "require", "verify-ca", "verify-full"].includes(sslmode)) {
    throw new Error("Parámetros de conexión PostgreSQL no admitidos.");
  }
  return {
    PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
    PGHOST: url.hostname.replace(/^\[|\]$/g, ""),
    PGPORT: url.port || "5432",
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGSSLMODE: sslmode,
    PGCONNECT_TIMEOUT: "10",
  };
}

export function origenCopia() {
  const app = URL.parse(process.env.APP_BASE_URL ?? "");
  const revision = process.env.VOCERO_REVISION ?? "";
  const clave = Buffer.from(process.env.ENCRYPTION_KEY ?? "", "base64");
  if (!app || !["https:", "http:"].includes(app.protocol) || clave.length !== 32) {
    throw new Error("Faltan APP_BASE_URL o la clave de cifrado de la instancia.");
  }
  return {
    instancia: app.origin,
    revision: /^[a-f0-9]{40}$/.test(revision) ? revision : null,
    huellaClave: createHash("sha256").update(clave).digest("hex"),
  };
}

export async function publicar(config, tipo, archivo, dir) {
  const origen = origenCopia();
  const fecha = new Date().toISOString();
  const id = `${fecha.replace(/[:.]/g, "-")}-${randomUUID()}`;
  const prefijo = `${tipo}/${id}`;
  const llave = `${prefijo}/${archivo}`;
  const local = join(dir, archivo);
  const esperado = await huella(local);
  await s3(config, ["s3", "cp", local, uri(config, llave), "--only-show-errors"]);
  const verificado = join(dir, "verificacion");
  await s3(config, ["s3", "cp", uri(config, llave), verificado, "--only-show-errors"]);
  if (!await coincide(verificado, esperado)) throw new Error("El archivo remoto difiere del original.");
  const manifiesto = join(dir, "manifiesto.json");
  await writeFile(manifiesto, JSON.stringify({ version: 1, id, fecha, archivo, origen, ...esperado }), { mode: 0o600 });
  await s3(config, ["s3api", "put-object", "--bucket", config.bucket, "--key", `${prefijo}/manifiesto.json`,
    "--body", manifiesto, "--if-none-match", "*", "--content-type", "application/json"]);
  return { id, llave, ...esperado };
}

export function copiaPostgres() {
  const config = configBucket("COPIAS");
  if (process.env.MEDIA_STORE === "bucket") comprobarSeparacion(config, configBucket("MEDIA"));
  return temporal(async (dir) => {
    const archivo = "vocero.dump";
    const ruta = join(dir, archivo);
    const variables = conexionPostgres();
    const bytes = Number(await ejecutar("psql", ["-XAt", "--no-password", "-v", "ON_ERROR_STOP=1",
      "-c", "select pg_database_size(current_database())"], { variables, capturar: true }));
    await comprobarEspacio(dir, bytes * 2);
    await ejecutar("pg_dump", ["-Fc", "--no-password", "--lock-wait-timeout=10s", "--file", ruta], {
      variables,
    });
    await ejecutar("pg_restore", ["--list", ruta]);
    return publicar(config, "postgres", archivo, dir);
  });
}
