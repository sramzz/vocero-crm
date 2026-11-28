import { cp, lstat, mkdir, readFile, readdir, realpath, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { coincide, comprobarEspacio, comprobarSeparacion, configBucket, ejecutar, huella, s3, uri } from "./almacen.mjs";
import { conexionPostgres, origenCopia, publicar, temporal } from "./respaldo.mjs";

const segmento = /^[\w.-]+$/;
const llaveValida = (llave) => typeof llave === "string" && llave.split("/").length === 2
  && llave.split("/").every((parte) => segmento.test(parte) && parte !== "." && parte !== "..");

async function inventario() {
  const raiz = process.env.MEDIA_DIR || "/data/media";
  if (await realpath(raiz) !== raiz) throw new Error("MEDIA_DIR debe ser un directorio real.");
  const llaves = [];
  for (const org of await readdir(raiz)) {
    // El sondeo de salud puede escribir brevemente en la raíz.
    if (/^\.prueba-escritura-\d+$/.test(org)) continue;
    const dir = join(raiz, org);
    if (!llaveValida(`${org}/medio`) || !(await lstat(dir)).isDirectory()) throw new Error("Directorio de medios inválido.");
    for (const nombre of await readdir(dir)) {
      const llave = `${org}/${nombre}`;
      if (!llaveValida(llave) || !(await lstat(join(raiz, llave))).isFile()) throw new Error("Archivo de medios inválido.");
      llaves.push(llave);
    }
  }
  return { raiz, llaves: llaves.sort() };
}

async function tiposDeMedios() {
  const sql = `select coalesce(json_object_agg(clave, tipo), '{}') from (
    select storage_path as clave, mime_type as tipo from media_asset
      where fetch_status = 'available' and storage_path is not null
    union all
    select id || '/favicon', metadata::jsonb #>> '{branding,favicon,mime}' from organization
      where metadata::jsonb #>> '{branding,favicon,mime}' is not null
  ) as medios`;
  const datos = await ejecutar("psql", ["-XAt", "--no-password", "-v", "ON_ERROR_STOP=1", "-c", sql], {
    variables: conexionPostgres(), capturar: true,
  });
  return new Map(Object.entries(JSON.parse(datos)));
}

function destinos() {
  if (process.env.MEDIA_STORE !== "bucket") throw new Error("Se requiere MEDIA_STORE=bucket.");
  const medios = configBucket("MEDIA");
  const copias = configBucket("COPIAS");
  comprobarSeparacion(copias, medios);
  return { medios, copias };
}

export function protegerMedios() {
  const { medios, copias } = destinos();
  return temporal(async (dir) => {
    const { raiz, llaves } = await inventario();
    const objetos = await inventarioRemoto(medios);
    let bytes = [...objetos.values()].reduce((total, tamano) => total + tamano, 0);
    for (const llave of llaves) bytes += (await lstat(join(raiz, llave))).size;
    await comprobarEspacio(dir, (bytes + (llaves.length + objetos.size) * 4096) * 4);
    await mkdir(join(dir, "bucket"));
    await s3(medios, ["s3", "sync", uri(medios), join(dir, "bucket"), "--only-show-errors"]);
    const archivos = [];
    for (const llave of llaves) {
      const destino = join(dir, "local", llave);
      await mkdir(dirname(destino), { recursive: true });
      await cp(join(raiz, llave), destino, { errorOnExist: true, force: false });
      archivos.push({ llave, ...await huella(destino) });
    }
    await mkdir(join(dir, "local"), { recursive: true });
    await writeFile(join(dir, "inventario.json"), JSON.stringify(archivos), { mode: 0o600 });
    await ejecutar("tar", ["-czf", join(dir, "medios.tar.gz"), "-C", dir, "inventario.json", "local", "bucket"]);
    return publicar(copias, "medios", "medios.tar.gz", dir);
  });
}

async function inventarioRemoto(medios) {
  const salida = await s3(medios, ["s3api", "list-objects-v2", "--bucket", medios.bucket,
    "--query", "Contents[].[Key,Size]", "--output", "json"], true);
  return new Map(JSON.parse(salida) ?? []);
}

async function verificarRemoto(medios, llave, esperado, dir) {
  const ruta = join(dir, "objeto");
  await s3(medios, ["s3", "cp", uri(medios, llave), ruta, "--only-show-errors"]);
  if (!await coincide(ruta, esperado)) throw new Error("Un objeto remoto difiere del archivo local.");
}

export async function copiarMedios(simulacro) {
  const { medios } = destinos();
  const { raiz, llaves } = await inventario();
  const [tipos, remotos] = await Promise.all([tiposDeMedios(), inventarioRemoto(medios)]);
  const locales = new Set(llaves);
  for (const llave of tipos.keys()) {
    if (!llaveValida(llave) || (!locales.has(llave) && !remotos.has(llave))) {
      throw new Error("Hay referencias de medios sin archivo disponible.");
    }
  }
  if (simulacro) return { locales: llaves.length, referencias: tipos.size };
  return temporal(async (dir) => {
    for (const llave of llaves) {
      const ruta = join(raiz, llave);
      const esperado = await huella(ruta);
      if (!remotos.has(llave)) {
        await s3(medios, ["s3api", "put-object", "--bucket", medios.bucket, "--key", llave,
          "--body", ruta, "--if-none-match", "*", "--content-type", tipos.get(llave) || "application/octet-stream"]);
      }
      await verificarRemoto(medios, llave, esperado, dir);
    }
    return { verificados: llaves.length };
  });
}

export async function limpiarMedios(id) {
  if (!/^\d{4}-[\dTZ-]+-[a-f0-9-]{36}$/.test(id ?? "")) {
    throw new Error("Indica el ID de una copia de medios restaurada y verificada.");
  }
  const { medios, copias } = destinos();
  return temporal(async (dir) => {
    const nombre = "medios.tar.gz";
    const archivo = join(dir, nombre);
    const rutaManifiesto = join(dir, "manifiesto.json");
    await s3(copias, ["s3", "cp", uri(copias, `medios/${id}/manifiesto.json`), rutaManifiesto, "--only-show-errors"]);
    const manifiesto = JSON.parse(await readFile(rutaManifiesto, "utf8"));
    const origen = origenCopia();
    if (manifiesto.version !== 1 || manifiesto.id !== id || manifiesto.archivo !== nombre
      || manifiesto.origen?.instancia !== origen.instancia || manifiesto.origen?.huellaClave !== origen.huellaClave) {
      throw new Error("El manifiesto de la copia es inválido.");
    }
    await comprobarEspacio(dir, manifiesto.bytes * 2);
    await s3(copias, ["s3", "cp", uri(copias, `medios/${id}/${nombre}`), archivo, "--only-show-errors"]);
    if (!await coincide(archivo, manifiesto)) throw new Error("La copia de medios no coincide con el manifiesto.");
    const datos = JSON.parse(await ejecutar("tar", ["-xOzf", archivo, "inventario.json"], { capturar: true }));
    const protegidos = new Map(datos.map((dato) => [dato.llave, dato]));
    const { raiz, llaves } = await inventario();
    for (const llave of llaves) {
      const esperado = protegidos.get(llave);
      if (!esperado || !await coincide(join(raiz, llave), esperado)) {
        throw new Error("Un archivo local cambió o está fuera de la copia de medios.");
      }
      const recuperado = join(dir, "recuperado");
      await ejecutar("tar", ["-xOzf", archivo, `local/${llave}`], { archivo: recuperado });
      if (!await coincide(recuperado, esperado)) throw new Error("Un archivo protegido difiere del inventario.");
      await verificarRemoto(medios, llave, esperado, dir);
    }
    for (const llave of llaves) {
      const ruta = join(raiz, llave);
      if (!await coincide(ruta, protegidos.get(llave))) throw new Error("Un archivo local cambió durante la limpieza.");
      await unlink(ruta);
    }
    return { eliminados: llaves.length };
  });
}
