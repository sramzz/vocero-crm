import { randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, open, readFile, rename, rm, statfs, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { archivos, claveMedia, comando, comprobarDespliegue, comprobarRevision, contenedores, descargar, descubrir, docker, hashSeguro,
  huellaArchivo, idSeguro, ligados, listar, objetos, quitar, rutaReal, subir, subirParte } from "./infra.mjs";

const json = (ruta) => readFile(ruta, "utf8").then(JSON.parse);
const detalle = z.object({ bytes: z.number().int().nonnegative(), sha256: hashSeguro }).strict();
const formato = z.object({
  version: z.literal(1),
  uuid: idSeguro,
  id: idSeguro,
  capturada: z.iso.datetime(),
  revision: z.string().regex(/^[a-f0-9]{40}$/),
  modo: z.enum(["disco", "bucket"]),
  referenciaClave: idSeguro,
  huellaClave: hashSeguro,
  partes: z.object({
    "vocero.dump": detalle,
    "datos.tar": detalle,
    "medios.tar": detalle.optional(),
  }).strict(),
}).strict();
const inventario = z.object({
  uuid: idSeguro,
  id: idSeguro,
  bucket: z.string(),
  endpoint: z.string(),
  respaldo: idSeguro,
  items: z.array(z.object({ clave: claveMedia, ...detalle.shape })),
}).strict();

const igual = (a, b) => a.bytes === b.bytes && a.sha256 === b.sha256;
const manifiesto = "manifiesto.json";
const indiceMedios = "indice.json";
const tipoMedia = z.string().regex(/^[\w.+-]+\/[\w.+-]+$/);
const entradaIndice = z.object({ clave: claveMedia, tipo: tipoMedia });


async function existe(ruta) {
  return lstat(ruta).then(() => true, (e) => {
    if (e.code === "ENOENT") return false;
    throw e;
  });
}

async function temporal(fn) {
  const dir = await mkdtemp(join(process.env.COPIAS_TEMPORAL || tmpdir(), "vocero-copias-"));
  try { return await fn(dir); }
  finally { await rm(dir, { recursive: true, force: true }); }
}

async function guardarJson(ruta, datos) {
  const tmp = `${ruta}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(datos), { mode: 0o600, flag: "wx", flush: true });
  await rename(tmp, ruta);
  const carpeta = await open(dirname(ruta), "r");
  try { await carpeta.sync(); } finally { await carpeta.close(); }
}

export function diario(base, uuid) {
  return join(base, `${uuid}.reanudacion.json`);
}

export async function reanudar(base, uuid) {
  const ruta = diario(base, uuid);
  if (!await existe(ruta)) return;
  const ids = z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(2).parse(await json(ruta));
  const rec = await descubrir(uuid);
  if (ids.some((id) => ![rec.servicios.app.Id, rec.servicios.nea.Id].includes(id))) {
    throw new Error("Cambió la identidad de los escritores. Reanuda los servicios desde Coolify.");
  }
  if (ids.length) {
    await docker(["start", ...ids]);
    const limite = Date.now() + 90_000;
    for (;;) {
      const estado = JSON.parse(await docker(["inspect", ...ids], { capturar: true }));
      if (estado.every((c) => c.State.Running && (!c.State.Health || c.State.Health.Status === "healthy"))) break;
      if (Date.now() >= limite) throw new Error("No se recuperó la salud de los escritores. Revisa Coolify.");
      await new Promise((r) => setTimeout(r, 1_000));
    }
  }
  await unlink(ruta);
}

async function ventana(ctx, rec, signal, fn) {
  const { base, uuid, config } = ctx;
  await reanudar(base, uuid);
  await comprobarDespliegue(config, uuid);
  const ids = [rec.servicios.app, rec.servicios.nea].filter((c) => c.State.Running).map((c) => c.Id);
  const plazo = AbortSignal.any([signal, AbortSignal.timeout(300_000)]);
  await guardarJson(diario(base, uuid), ids);
  try {
    if (ids.length) await docker(["stop", "--time", "20", ...ids], { signal: plazo });
    const sinEscritores = async () => {
      await comprobarDespliegue(config, uuid);
      const actual = await descubrir(uuid, { signal: plazo });
      if (["app", "nea", "postgres"].some((nombre) => actual.servicios[nombre].Id !== rec.servicios[nombre].Id)
        || actual.servicios.app.State.Running || actual.servicios.nea.State.Running) {
        throw new Error("Los escritores siguen activos o cambió el despliegue.");
      }
    };
    await sinEscritores();
    const resultado = await fn(plazo, sinEscritores);
    await sinEscritores();
    plazo.throwIfAborted();
    return resultado;
  } finally {
    await reanudar(base, uuid);
  }
}

async function comprobarRemoto(s, key, info, dir, señal) {
  const ruta = join(dir, randomUUID());
  try {
    await descargar(s, key, ruta, señal);
    const actual = await huellaArchivo(ruta, señal);
    if (!igual(info, actual)) throw new Error("La copia remota no coincide con la captura.");
  } finally { await rm(ruta, { force: true }); }
}

async function archivar(origen, destino, señal) {
  await archivos(origen);
  await comando("tar", ["-C", origen, "-cf", "-", "."], { salida: destino, signal: señal, limiteMs: 300_000 });
}

async function descargarMedia(cfg, { Key: key, Size, ETag }, dir, señal) {
  if (!ETag) throw new Error("El bucket debe devolver un ETag por objeto.");
  const ruta = join(dir, claveMedia.parse(key));
  await mkdir(dirname(ruta), { recursive: true, mode: 0o700 });
  await rm(ruta, { force: true });
  const meta = JSON.parse(await descargar(cfg, key, ruta, señal, ETag));
  if (meta.ETag !== ETag || (await lstat(ruta)).size !== Size) throw new Error("El objeto cambió durante la captura.");
  const tipo = tipoMedia.safeParse(meta.ContentType?.split(";")[0]);
  return { clave: key, tipo: tipo.success ? tipo.data : "application/octet-stream" };
}

async function prepararBucket(cfg, dir, inicial, señal) {
  await mkdir(dir, { mode: 0o700 });
  const listos = new Map();
  for (const objeto of inicial) {
    señal.throwIfAborted();
    try {
      listos.set(objeto.Key, { entrada: await descargarMedia(cfg, objeto, dir, señal), etag: objeto.ETag });
    } catch {
      await rm(join(dir, claveMedia.parse(objeto.Key)), { force: true });
      // Puede haber escrituras concurrentes. La reconciliación verifica en la ventana.
    }
  }
  return listos;
}

async function cerrarCapturaBucket(cfg, dir, listos, señal) {
  const final = await objetos(cfg, "", señal);
  const vigentes = new Set(final.map((o) => claveMedia.parse(o.Key)));
  for (const clave of listos.keys()) if (!vigentes.has(clave)) await rm(join(dir, clave));
  const indice = [];
  for (const objeto of final) {
    const previo = listos.get(objeto.Key);
    indice.push(previo?.etag === objeto.ETag && previo
      ? previo.entrada : await descargarMedia(cfg, objeto, dir, señal));
  }
  await guardarJson(join(dir, indiceMedios), indice);
}

async function comprobarDestino(s, uuid, dir, señal) {
  const ruta = join(dir, "sondeo");
  const key = `${uuid}/sondeo/${randomUUID()}`;
  await writeFile(ruta, "sondeo", { mode: 0o600 });
  await subir(s, key, ruta, señal);
  try { await comprobarRemoto(s, key, await huellaArchivo(ruta), dir, señal); }
  finally { await quitar(s, key); }
}

async function retener(s, uuid, dir, señal) {
  const limite = Date.now() - 30 * 86_400_000;
  const keys = await listar(s, `${uuid}/`, señal);
  const completos = [];
  const conManifiesto = new Set(keys.filter((key) => key.endsWith("/" + manifiesto)).map((key) => key.split("/")[1]));
  for (const key of keys) {
    const [, id, nombre, extra] = key.split("/");
    if (extra || !/^\d{13}-[a-f0-9-]{36}$/.test(id ?? "") || conManifiesto.has(id)
      || !["vocero.dump", "datos.tar", "medios.tar"].includes(nombre) || Number(id.slice(0, 13)) >= Date.now() - 172_800_000) continue;
    await quitar(s, key, señal);
  }
  for (const key of keys) {
    const partes = key.split("/");
    if (partes.length !== 3 || partes[2] !== manifiesto) continue;
    try {
      completos.push(await leerManifiesto(s, uuid, partes[1], dir, señal));
    } catch { console.warn("Se omitió la retención de un conjunto ilegible."); }
  }
  completos.sort((a, b) => b.capturada.localeCompare(a.capturada));
  for (const m of completos.slice(1)) {
    if (Date.parse(m.capturada) >= limite) continue;
    const prefijo = `${uuid}/${m.id}/`;
    await quitar(s, prefijo + manifiesto, señal);
    for (const nombre of Object.keys(m.partes)) await quitar(s, prefijo + nombre, señal);
  }
}

export async function backup(ctx, señal) {
  const { uuid, cfg, config } = ctx;
  if (cfg.destinoPrueba) throw new Error("El destino de restauración no genera copias.");
  const rec = await descubrir(uuid);
  const revision = await comprobarRevision(rec, cfg);
  const modo = await ligados(rec, cfg);
  await rutaReal(rec.datos);
  return temporal(async (dir) => {
    const db = rec.servicios.postgres.Id;
    const infoDb = await docker(["exec", db, "psql", "-XAt", "-U", cfg.dumpUsuario, "-d", "vocero", "-c", "select pg_database_size(current_database())"], { capturar: true, signal: señal });
    let bytes = Number(infoDb.trim());
    if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new Error("No se pudo estimar el espacio de PostgreSQL.");
    for (const nombre of await archivos(rec.datos)) bytes += (await lstat(join(rec.datos, nombre))).size;
    const objetosIniciales = cfg.medios ? await objetos(cfg.medios, "", señal) : [];
    for (const objeto of objetosIniciales) {
      claveMedia.parse(objeto.Key);
      if (!objeto.ETag) throw new Error("El bucket debe devolver un ETag por objeto.");
      bytes += 2 * objeto.Size;
    }
    const fs = await statfs(dir);
    if (fs.bavail * fs.bsize < 2 * bytes + 64 * 1024 * 1024) throw new Error("Espacio temporal insuficiente.");
    await comprobarDestino(config.archivo, uuid, dir, señal);
    const origen = join(dir, "bucket");
    const listos = cfg.medios ? await prepararBucket(cfg.medios, origen, objetosIniciales, señal) : null;
    const capturada = await ventana(ctx, rec, señal, async (plazo) => {
      const fecha = new Date().toISOString();
      await docker(["exec", db, "pg_dump", "-U", cfg.dumpUsuario, "-Fc", "vocero"],
        { salida: join(dir, "vocero.dump"), signal: plazo, limiteMs: 300_000 });
      await archivar(rec.datos, join(dir, "datos.tar"), plazo);
      if (cfg.medios) await cerrarCapturaBucket(cfg.medios, origen, listos, plazo);
      return fecha;
    });
    if (cfg.medios) {
      await archivar(origen, join(dir, "medios.tar"), señal);
      await rm(origen, { recursive: true, force: true });
    }
    const id = `${Date.parse(capturada)}-${randomUUID()}`;
    const prefijo = `${uuid}/${id}/`;
    const partes = {};
    for (const nombre of ["vocero.dump", "datos.tar", ...(cfg.medios ? ["medios.tar"] : [])]) {
      const ruta = join(dir, nombre);
      partes[nombre] = await huellaArchivo(ruta);
      await subirParte(config.archivo, prefijo + nombre, ruta, señal);
      await comprobarRemoto(config.archivo, prefijo + nombre, partes[nombre], dir, señal);
    }
    const m = formato.parse({ version: 1, uuid, id, capturada, revision, modo,
      referenciaClave: cfg.referenciaClave, huellaClave: cfg.huellaClave, partes });
    const ruta = join(dir, manifiesto);
    await guardarJson(ruta, m);
    await subir(config.archivo, prefijo + manifiesto, ruta, señal);
    try { await comprobarRemoto(config.archivo, prefijo + manifiesto, await huellaArchivo(ruta), dir, señal); }
    catch (e) { await quitar(config.archivo, prefijo + manifiesto); throw e; }
    try { await retener(config.archivo, uuid, dir, señal); }
    catch { console.warn("La copia es válida. No se pudo completar la retención."); }
    return { id, capturada, verificada: new Date().toISOString() };
  });
}

async function leerManifiesto(s, uuid, id, dir, señal) {
  idSeguro.parse(id);
  const ruta = join(dir, randomUUID());
  await descargar(s, `${uuid}/${id}/${manifiesto}`, ruta, señal);
  try {
    const m = formato.parse(await json(ruta));
    if (m.uuid !== uuid || m.id !== id) throw new Error("El manifiesto pertenece a otro conjunto.");
    return m;
  } finally { await rm(ruta, { force: true }); }
}

async function descargarConjunto(s, uuid, id, dir, señal) {
  const m = await leerManifiesto(s, uuid, id, dir, señal);
  for (const [nombre, info] of Object.entries(m.partes)) {
    const ruta = join(dir, nombre);
    await descargar(s, `${uuid}/${id}/${nombre}`, ruta, señal);
    if (!igual(info, await huellaArchivo(ruta))) throw new Error("Falló la integridad del conjunto.");
  }
  return m;
}

async function extraer(tar, dir, señal) {
  await comando("tar", ["--no-same-owner", "--no-same-permissions", "-xf", tar, "-C", dir],
    { signal: señal, limiteMs: 300_000 });
  return archivos(dir);
}

export async function restore(ctx, source, id, señal) {
  const { config, cfg, uuid, base } = ctx;
  if (!cfg.destinoPrueba || uuid === source || !config.instancias[source] || config.instancias[source].destinoPrueba) {
    throw new Error("Se requiere un origen y un destino desechable distinto.");
  }
  const rec = await descubrir(uuid);
  const origen = await contenedores(source, señal);
  const volumenesOrigen = new Set(origen.flatMap((c) => c.Mounts.map((m) => m.Source)));
  const revision = await comprobarRevision(rec, cfg);
  const modo = await ligados(rec, cfg);
  if (rec.servicios.app.State.Running || rec.servicios.nea.State.Running || await existe(diario(base, uuid))
    || volumenesOrigen.has(rec.datos) || volumenesOrigen.has(rec.pgDatos)) {
    throw new Error("Apaga los escritores y usa volúmenes exclusivos en el destino.");
  }
  const redesPorServicio = Object.values(rec.servicios).map((c) => {
    const redes = Object.keys(c.NetworkSettings.Networks ?? {});
    return redes.length ? redes : [c.HostConfig.NetworkMode].filter(Boolean);
  });
  const redes = [...new Set(redesPorServicio.flat())];
  if (redesPorServicio.some((n) => !n.length)) throw new Error("Todos los servicios del destino necesitan red interna.");
  const inspect = JSON.parse(await docker(["network", "inspect", ...redes], { capturar: true }));
  const redesOrigen = new Set(origen.flatMap((c) => Object.keys(c.NetworkSettings.Networks ?? {})));
  const ids = new Set(Object.values(rec.servicios).map((c) => c.Id));
  if (inspect.some((n) => !n.Internal || redesOrigen.has(n.Name) || n.Ingress ||
    n.Labels?.["com.docker.compose.project"] !== rec.proyecto || Object.keys(n.Containers ?? {}).some((id) => !ids.has(id)))
    || Object.values(rec.servicios).some((c) => c.HostConfig.NetworkMode === "host" ||
      c.HostConfig.PublishAllPorts || Object.keys(c.HostConfig.PortBindings ?? {}).length)) {
    throw new Error("El destino debe estar en redes internas exclusivas y sin puertos públicos.");
  }
  for (const volumen of rec.volumenes) {
    const usuarios = await docker(["ps", "-aq", "--no-trunc", "--filter", `volume=${volumen}`], { capturar: true });
    if (usuarios.split(/\s+/).filter(Boolean).some((id) => !ids.has(id))) {
      throw new Error("Otro contenedor usa un volumen de restauración.");
    }
  }
  await rutaReal(rec.datos);
  if ((await archivos(rec.datos)).length || (cfg.medios && (await listar(cfg.medios, "", señal)).length)) {
    throw new Error("El almacenamiento de destino no está vacío.");
  }
  const db = rec.servicios.postgres.Id;
  const cuenta = await docker(["exec", db, "psql", "-XAt", "-U", cfg.dumpUsuario, "-d", "vocero", "-c",
    "select count(*) from pg_namespace where nspname not in ('public','information_schema') and nspname not like 'pg_%' union all select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' union all select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'"],
  { capturar: true, signal: señal });
  if (cuenta.trim() !== "0\n0\n0") throw new Error("La base de destino no está vacía.");
  return temporal(async (dir) => {
    const m = await descargarConjunto(config.archivo, source, id, dir, señal);
    if (m.revision !== revision || m.huellaClave !== cfg.huellaClave || m.modo !== modo
      || !!m.partes["medios.tar"] !== !!cfg.medios) throw new Error("La revisión, clave o medios del destino no coinciden.");
    // Restaurar solo después de validar ambos archivos y el destino.
    await rm(join(base, `${uuid}.restaurada.json`), { force: true });
    const datos = join(dir, "datos");
    await mkdir(datos, { mode: 0o700 });
    await extraer(join(dir, "datos.tar"), datos, señal);
    let indice = [];
    const medios = join(dir, "medios");
    if (cfg.medios) {
      await mkdir(medios, { mode: 0o700 });
      const claves = (await extraer(join(dir, "medios.tar"), medios, señal)).filter((key) => key !== indiceMedios);
      indice = z.array(entradaIndice).parse(await json(join(medios, indiceMedios)));
      const declaradas = new Set(indice.map((i) => i.clave));
      if (declaradas.size !== indice.length || claves.length !== indice.length || claves.some((key) => !declaradas.has(key))) {
        throw new Error("El índice de objetos no coincide con el archivo de medios.");
      }
    }
    await docker(["exec", "-i", db, "pg_restore", "--exit-on-error", "--single-transaction", "--no-owner", "--no-privileges", "-U", cfg.dumpUsuario,
      "-d", "vocero"], { entrada: join(dir, "vocero.dump"), signal: señal, limiteMs: 600_000 });
    await extraer(join(dir, "datos.tar"), rec.datos, señal);
    if (cfg.medios) for (const { clave: key, tipo } of indice) {
      const ruta = join(medios, key);
      await subir(cfg.medios, key, ruta, señal, { tipo, cifrado: false });
      await comprobarRemoto(cfg.medios, key, await huellaArchivo(ruta), dir, señal);
    }
    await guardarJson(join(base, `${uuid}.restaurada.json`), { source, id, target: uuid });
    return { id, estado: "restaurada_pendiente_de_verificar" };
  });
}

export async function certificar(ctx, source, id) {
  if (!ctx.cfg.destinoPrueba || source === ctx.uuid) throw new Error("Se requiere el destino desechable restaurado.");
  const evidencia = await json(join(ctx.base, `${ctx.uuid}.restaurada.json`));
  if (evidencia.source !== source || evidencia.id !== id || evidencia.target !== ctx.uuid) {
    throw new Error("El destino no corresponde a la copia indicada.");
  }
  await guardarJson(join(ctx.base, `${source}.${id}.verificada.json`), evidencia);
  return { id, estado: "restauracion_verificada_por_operador" };
}

async function catalogo(rec, cfg, dir, señal) {
  const raiz = join(rec.datos, "media");
  const keys = await existe(raiz) ? await archivos(await rutaReal(raiz)) : [];
  for (const key of keys) claveMedia.parse(key);
  const remotos = new Set(await listar(cfg.medios, "", señal));
  for (const key of remotos) claveMedia.parse(key);
  const consulta = `select coalesce(json_agg(json_build_object('key', clave, 'tipo', tipo)), '[]')
    from (
      select storage_path as clave, mime_type as tipo from media_asset
      where fetch_status='available' and storage_path is not null and organization_id = :'org'
      union all
      select id || '/favicon', metadata::jsonb #>> '{branding,favicon,mime}' from organization
      where id = :'org' and metadata::jsonb #>> '{branding,favicon,mime}' is not null
    ) as medios;`;
  const sql = join(dir, "inventario.sql");
  await writeFile(sql, consulta, { mode: 0o600, flag: "wx" });
  const salida = await docker(["exec", "-i", rec.servicios.postgres.Id, "psql", "-XAt", "-v", "ON_ERROR_STOP=1",
    "-v", `org=${cfg.organizacion}`, "-U", cfg.dumpUsuario, "-d", "vocero", "-f", "-"],
  { capturar: true, entrada: sql, signal: señal });
  const metadata = new Map(JSON.parse(salida).map((a) => [claveMedia.parse(a.key), a.tipo]));
  const locales = new Set(keys);
  for (const key of metadata.keys()) {
    if (!locales.has(key) && !remotos.has(key)) throw new Error("Un adjunto disponible no tiene copia en ningún origen.");
  }
  return { keys, remotos, raiz, metadata };
}

export async function mediaMigrate(ctx, op, id, respaldo, señal) {
  const { uuid, cfg, config, base } = ctx;
  const rec = await descubrir(uuid);
  await comprobarRevision(rec, cfg);
  if (!cfg.medios || await ligados(rec, cfg) !== "bucket" || cfg.destinoPrueba) {
    throw new Error("Se requiere una instancia provisionada en modo bucket.");
  }
  await rutaReal(rec.datos);
  return temporal(async (dir) => {
    if (op === "dry-run") {
      const c = await catalogo(rec, cfg, dir, señal);
      return { locales: c.keys.length, remotos: c.remotos.size };
    }
    // La copia previa se valida antes de detener los servicios.
    const repetir = op === "prune" && await existe(join(base, `${id}.limpieza.json`));
    const m = op === "prune" ? inventario.parse(await json(join(base, `${id}.medios.json`))) : null;
    if (m && (m.id !== id || m.uuid !== uuid || m.bucket !== cfg.medios.bucket || m.endpoint !== cfg.medios.endpoint)) {
      throw new Error("El manifiesto pertenece a otro destino.");
    }
    if (m) {
      const prueba = await json(join(base, `${uuid}.${m.respaldo}.verificada.json`)).catch(() => null);
      if (prueba?.source !== uuid || prueba.id !== m.respaldo || !config.instancias[prueba.target]?.destinoPrueba) {
        throw new Error("Certifica la restauración de la copia antes de limpiar.");
      }
    }
    const copia = await descargarConjunto(config.archivo, uuid, m?.respaldo ?? respaldo, dir, señal);
    const archivoDisco = join(dir, "datos-copia");
    await mkdir(archivoDisco, { mode: 0o700 });
    await extraer(join(dir, "datos.tar"), archivoDisco, señal);
    if (copia.huellaClave !== cfg.huellaClave) throw new Error("Se requiere una copia con la clave actual.");
    return ventana(ctx, rec, señal, async (plazo, sinEscritores) => {
      const c = await catalogo(rec, cfg, dir, plazo);
      if (m) {
        const porClave = new Map(m.items.map((i) => [i.clave, i]));
        if (c.keys.some((key) => !porClave.has(key)) || (!repetir && c.keys.length !== m.items.length)) {
          throw new Error("El inventario local cambió. Genera un manifiesto nuevo.");
        }
        for (const item of m.items) {
          plazo.throwIfAborted();
          await comprobarRemoto(cfg.medios, item.clave, item, dir, plazo);
          if (!igual(item, await huellaArchivo(join(archivoDisco, "media", item.clave), plazo))) throw new Error("La copia de seguridad no cubre este archivo.");
          if (await existe(join(c.raiz, item.clave))
            && !igual(item, await huellaArchivo(join(c.raiz, item.clave), plazo))) throw new Error("Cambió un medio local.");
        }
        await sinEscritores();
        await guardarJson(join(base, `${id}.limpieza.json`), { uuid, id });
        for (const key of c.keys) {
          plazo.throwIfAborted();
          await unlink(join(c.raiz, key));
        }
        return { id, eliminados: c.keys.length };
      }
      const items = [];
      for (const key of c.keys) {
        plazo.throwIfAborted();
        if (!key.startsWith(`${cfg.organizacion}/`)) throw new Error("Existe un archivo de otra organización.");
        const ruta = join(c.raiz, key);
        const info = await huellaArchivo(ruta, plazo);
        if (!igual(info, await huellaArchivo(join(archivoDisco, "media", key), plazo))) throw new Error("Toma una copia nueva antes de trasladar los medios.");
        const mime = c.metadata.get(key);
        const tipo = typeof mime === "string" && /^[\w.+-]+\/[\w.+-]+$/.test(mime) ? mime
          : basename(key) === "favicon" ? "image/png" : "application/octet-stream";
        if (!c.remotos.has(key)) await subir(cfg.medios, key, ruta, plazo, { tipo, cifrado: false });
        await comprobarRemoto(cfg.medios, key, info, dir, plazo);
        items.push({ clave: key, ...info });
      }
      const nuevo = randomUUID();
      await guardarJson(join(base, `${nuevo}.medios.json`), { uuid, id: nuevo, bucket: cfg.medios.bucket,
        endpoint: cfg.medios.endpoint, respaldo: copia.id, items });
      return { id: nuevo, verificados: items.length };
    });
  });
}
