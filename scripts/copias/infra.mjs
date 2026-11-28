import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, open, readFile, readdir, realpath, rm } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { pipeline } from "node:stream/promises";
import { z } from "zod";

export const idSeguro = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
export const hashSeguro = z.string().regex(/^[a-f0-9]{64}$/);
export const claveMedia = z.string().regex(/^[\w.-]+\/[\w.-]+$/)
  .refine((key) => key.split("/").every((p) => p !== "." && p !== ".."));
const almacen = z.object({
  bucket: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/),
  endpoint: z.url().refine((s) => {
    const url = new URL(s);
    return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash;
  }),
  region: idSeguro,
  perfil: idSeguro,
}).strict();
const instancia = z.object({
  organizacion: idSeguro,
  revision: z.string().regex(/^[a-f0-9]{40}$/).optional(),
  dumpUsuario: idSeguro.default("postgres"),
  huellaClave: hashSeguro,
  referenciaClave: idSeguro,
  conexionOperativa: z.string().regex(/^postgres(?:ql)?:\/\//).optional(),
  medios: almacen.nullable(),
  destinoPrueba: z.boolean().default(false),
}).strict();
const configSchema = z.object({
  archivo: almacen,
  coolify: z.object({
    url: z.url().refine((s) => {
      const u = new URL(s);
      return u.protocol === "https:" && !u.username && !u.password && !u.search && !u.hash && u.pathname === "/";
    }),
    token: z.string().min(8),
  }).strict(),
  instancias: z.record(idSeguro, instancia),
}).strict();

export async function leerConfig(ruta) {
  const info = await lstat(ruta);
  if (!info.isFile() || (info.mode & 0o077) !== 0) throw new Error("La configuración debe ser un archivo privado.");
  const datos = await readFile(ruta, "utf8").then(JSON.parse).catch(() => null);
  const parsed = configSchema.safeParse(datos);
  if (!parsed.success) throw new Error("Configuración del operador inválida.");
  const lugares = new Set();
  for (const cfg of Object.values(parsed.data.instancias)) {
    if (!cfg.medios) continue;
    const lugar = (s) => `${new URL(s.endpoint).origin}/${s.bucket}`;
    const id = lugar(cfg.medios);
    if (id === lugar(parsed.data.archivo) || lugares.has(id)) throw new Error("Los buckets deben ser exclusivos de cada propósito e instancia.");
    lugares.add(id);
  }
  return parsed.data;
}

export async function comando(bin, args, { signal, entrada, salida, env, capturar = false, limiteMs = 120_000 } = {}) {
  const archivo = salida ? await open(salida, "wx", 0o600) : null;
  const limite = AbortSignal.timeout(limiteMs);
  const combinado = signal ? AbortSignal.any([signal, limite]) : limite;
  const child = spawn(bin, args, { env, stdio: [entrada ? "pipe" : "ignore", "pipe", "ignore"], signal: combinado, killSignal: "SIGKILL" });
  const terminado = new Promise((resolve, reject) => {
    child.once("error", () => reject(new Error(`${bin} no pudo ejecutarse o fue interrumpido.`)));
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`${bin} terminó con error (${code ?? "señal"}).`)));
  });
  const partes = [];
  let bytes = 0;
  const leer = salida
    ? pipeline(child.stdout, archivo.createWriteStream())
    : (async () => {
      for await (const parte of child.stdout) {
        if (!capturar) continue;
        bytes += parte.length;
        if (bytes > 64 * 1024 * 1024) { child.kill("SIGKILL"); throw new Error("La salida excede el límite."); }
        partes.push(parte);
      }
    })();
  const alimentar = entrada ? pipeline(createReadStream(entrada), child.stdin) : undefined;
  try {
    await Promise.all([terminado, leer, alimentar]);
    return Buffer.concat(partes).toString("utf8");
  } catch (e) {
    child.kill("SIGKILL");
    await Promise.allSettled([terminado, leer, alimentar]);
    if (salida) await rm(salida, { force: true });
    throw e;
  }
}

const docker = (args, opts) => comando("docker", args, opts);

export async function contenedores(uuid, signal) {
  const resultados = await Promise.all([
    ["--filter", `label=coolify.applicationUuid=${uuid}`],
    ["--filter", "label=coolify.applicationId", "--filter", `label=com.docker.compose.project=${uuid}`],
  ].map((filtros) => docker(["ps", "-aq", ...filtros], { capturar: true, signal })));
  const ids = [...new Set(resultados.join("\n").split(/\s+/).filter(Boolean))];
  return ids.length ? JSON.parse(await docker(["inspect", ...ids], { capturar: true, signal })) : [];
}

export async function descubrir(uuid, { signal } = {}) {
  const rec = recursosInspeccionados(uuid, await contenedores(uuid, signal));
  const volumenes = JSON.parse(await docker(["volume", "inspect", ...rec.volumenes], { capturar: true, signal }));
  if (volumenes.length !== 2 || volumenes.some((v) => v.Driver !== "local" ||
    v.Labels?.["com.docker.compose.project"] !== rec.proyecto ||
    ![rec.datos, rec.pgDatos].includes(v.Mountpoint))) throw new Error("Los volúmenes del proyecto no son exclusivos.");
  return rec;
}

export function recursosInspeccionados(uuid, inspect) {
  const servicios = {};
  for (const nombre of ["app", "postgres", "nea"]) {
    const coincidencias = inspect.filter((c) => {
      const l = c.Config.Labels ?? {};
      const viaje = l["coolify.applicationUuid"] ?? (l["coolify.applicationId"] && l["com.docker.compose.project"]);
      return viaje === uuid && l["com.docker.compose.service"] === nombre
        && [undefined, "0"].includes(l["coolify.pullRequestId"]);
    });
    if (coincidencias.length !== 1) throw new Error(`Identidad ambigua del servicio ${nombre}.`);
    servicios[nombre] = coincidencias[0];
  }
  const proyectos = new Set(Object.values(servicios).map((c) => c.Config.Labels["com.docker.compose.project"]));
  const volumen = (c, destino) => {
    const m = c.Mounts.filter((x) => x.Destination === destino);
    if (m.length !== 1 || m[0].Type !== "volume" || m[0].Driver !== "local" || !isAbsolute(m[0].Source)) {
      throw new Error(`Se requiere un volumen local en ${destino}.`);
    }
    if (typeof m[0].Name !== "string") throw new Error("Falta el nombre del volumen.");
    return m[0];
  };
  if (proyectos.size !== 1 || proyectos.has(undefined) || !servicios.postgres.State.Running) {
    throw new Error("El proyecto Compose no coincide o PostgreSQL está apagado.");
  }
  const datos = volumen(servicios.app, "/data");
  const pgDatos = volumen(servicios.postgres, "/var/lib/postgresql/data");
  if (datos.Name === pgDatos.Name || datos.Source === pgDatos.Source) throw new Error("Se requieren dos volúmenes distintos.");
  return {
    servicios, proyecto: proyectos.values().next().value,
    volumenes: [datos.Name, pgDatos.Name], datos: datos.Source, pgDatos: pgDatos.Source,
  };
}

export async function comprobarRevision(rec, cfg) {
  const app = rec.servicios.app;
  const [imagen] = JSON.parse(await docker(["image", "inspect", app.Image], { capturar: true }));
  const revision = imagen?.Config?.Labels?.["org.opencontainers.image.revision"];
  const esperada = app.Config.Env.find((e) => e.startsWith("SOURCE_COMMIT="))?.slice("SOURCE_COMMIT=".length);
  if (!revision || !/^[a-f0-9]{40}$/.test(revision) || revision !== esperada || (cfg.revision && revision !== cfg.revision)) {
    throw new Error("Habilita SOURCE_COMMIT en el build. La revisión de la imagen debe coincidir con la desplegada.");
  }
  return revision;
}

export async function ligados(rec, cfg) {
  const valor = (nombre) => rec.servicios.app.Config.Env.find((e) => e.startsWith(`${nombre}=`))?.slice(nombre.length + 1) || "";
  const hay = ["ENDPOINT", "NAME", "KEY_ID", "SECRET"].map((k) => valor(`MEDIA_BUCKET_${k}`));
  if (hay.some(Boolean) && !hay.every(Boolean)) throw new Error("Configuración de medios incompleta.");
  if (!!cfg.medios !== hay.every(Boolean) || (cfg.medios && (cfg.medios.bucket !== hay[1]
    || cfg.medios.endpoint.replace(/\/$/, "") !== hay[0].replace(/\/$/, "")))) {
    throw new Error("El bucket del operador no coincide con el usado por Vocero.");
  }
  const modo = valor("MEDIA_STORE").trim().toLowerCase();
  if (modo === "bucket" && !cfg.medios) throw new Error("El modo bucket requiere el almacenamiento configurado.");
  if (valor("MEDIA_DIR") && valor("MEDIA_DIR") !== "/data/media") throw new Error("El operador requiere MEDIA_DIR=/data/media.");
  const clave = Buffer.from(valor("ENCRYPTION_KEY"), "base64");
  if (clave.length !== 32 || createHash("sha256").update(clave).digest("hex") !== cfg.huellaClave) {
    throw new Error("La clave de la instancia no coincide con la huella configurada.");
  }
  return modo === "bucket" ? "bucket" : "disco";
}

export async function sha(ruta, signal) {
  const hash = createHash("sha256");
  for await (const parte of createReadStream(ruta, { signal })) hash.update(parte);
  return hash.digest("hex");
}

export async function huellaArchivo(ruta, signal) {
  const info = await lstat(ruta);
  if (!info.isFile()) throw new Error("Se requiere un archivo regular.");
  return { bytes: info.size, sha256: await sha(ruta, signal) };
}

export async function archivos(raiz, ruta = raiz) {
  const resultado = [];
  for (const nombre of await readdir(ruta)) {
    const absoluto = join(ruta, nombre);
    const info = await lstat(absoluto);
    if (info.isDirectory()) resultado.push(...await archivos(raiz, absoluto));
    else if (info.isFile()) resultado.push(relative(raiz, absoluto));
    else throw new Error("El volumen contiene un enlace u otro archivo no regular.");
  }
  return resultado.sort();
}

export async function rutaReal(raiz) {
  if (await realpath(raiz) !== raiz || !(await lstat(raiz)).isDirectory()) throw new Error("Volumen local inválido.");
  return raiz;
}

function aws(almacen, accion, args, signal) {
  return comando("aws", ["--no-cli-pager", "--no-cli-auto-prompt", "--profile", almacen.perfil, "--region", almacen.region,
    "--endpoint-url", almacen.endpoint, "s3api", accion, "--bucket", almacen.bucket, ...args],
  { signal, capturar: true, limiteMs: 600_000, env: { ...process.env, AWS_MAX_ATTEMPTS: "2", AWS_PAGER: "" } });
}

function cifradoGestionadoPorR2(almacen) {
  return /^[a-f0-9]{32}(?:\.(?:eu|fedramp|us))?\.r2\.cloudflarestorage\.com$/.test(new URL(almacen.endpoint).hostname);
}

export async function objetos(s, prefijo, señal) {
  const datos = await aws(s, "list-objects-v2", ["--prefix", prefijo, "--output", "json"], señal);
  return z.array(z.object({ Key: z.string(), Size: z.number().int().nonnegative(), ETag: z.string().optional() }))
    .parse(JSON.parse(datos).Contents ?? []);
}

export async function listar(s, prefijo, señal) {
  return (await objetos(s, prefijo, señal)).map((o) => o.Key);
}

export function descargar(s, key, ruta, señal, etag) {
  return aws(s, "get-object", ["--key", key, ...(etag ? ["--if-match", etag] : []), "--output", "json", ruta], señal);
}

export function subir(s, key, ruta, señal, { tipo, cifrado = true } = {}) {
  return aws(s, "put-object", ["--key", key, "--body", ruta, "--if-none-match", "*",
    ...(tipo ? ["--content-type", tipo] : []),
    ...(cifrado && !cifradoGestionadoPorR2(s) ? ["--server-side-encryption", "AES256"] : [])], señal);
}

export function quitar(s, key, señal) {
  return aws(s, "delete-object", ["--key", key], señal);
}

export { docker };

export async function comprobarDespliegue(config, uuid) {
  const url = new URL(`/api/v1/deployments/applications/${uuid}?take=10`, config.coolify.url);
  const r = await fetch(url, { headers: { Authorization: `Bearer ${config.coolify.token}` },
    signal: AbortSignal.timeout(5000), redirect: "error" }).catch(() => null);
  if (!r?.ok) throw new Error("No se pudo verificar el despliegue en Coolify.");
  const d = await r.json().catch(() => null);
  if (!Array.isArray(d?.deployments)
    || d.deployments.some((x) => !["finished", "failed", "cancelled", "canceled"].includes(x.status))) {
    throw new Error("Hay un despliegue activo o Coolify devolvió un estado desconocido.");
  }
}

export async function subirParte(s, key, ruta, señal) {
  await comando("aws", ["--no-cli-pager", "--no-cli-auto-prompt", "--profile", s.perfil, "--region", s.region,
    "--endpoint-url", s.endpoint, "s3", "cp", ruta, `s3://${s.bucket}/${key}`,
    ...(cifradoGestionadoPorR2(s) ? [] : ["--sse", "AES256"]), "--only-show-errors"],
  { signal: señal, limiteMs: 1_800_000 });
}
