import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { stat, statfs } from "node:fs/promises";
import { pipeline } from "node:stream/promises";

export async function ejecutar(binario, args, { variables = {}, capturar = false, archivo } = {}) {
  const proceso = spawn(binario, args, {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...variables },
    stdio: ["ignore", capturar || archivo ? "pipe" : "ignore", "ignore"],
    signal: AbortSignal.timeout(30 * 60_000),
  });
  const terminado = new Promise((resolve, reject) => {
    let salida = "";
    if (capturar) proceso.stdout.on("data", (datos) => {
      salida += datos;
      if (salida.length > 8 * 1024 * 1024) proceso.kill();
    });
    proceso.on("error", () => reject(new Error(`No se pudo ejecutar ${binario}.`)));
    proceso.on("close", (codigo) => {
      if (codigo === 0) resolve(salida);
      else reject(new Error(`${binario} terminó con código ${codigo ?? "de señal"}.`));
    });
  });
  const [salida] = await Promise.all([
    terminado,
    archivo && pipeline(proceso.stdout, createWriteStream(archivo, { mode: 0o600 })),
  ]);
  return salida;
}

export function configBucket(prefijo) {
  const valor = (nombre) => process.env[`${prefijo}_BUCKET_${nombre}`] ?? "";
  const endpoint = URL.parse(valor("ENDPOINT"));
  const bucket = valor("NAME");
  const id = valor("KEY_ID");
  const secreto = valor("SECRET");
  const region = valor("REGION") || "auto";
  if (!endpoint || endpoint.protocol !== "https:" || endpoint.username || endpoint.password
    || endpoint.pathname !== "/" || endpoint.search || endpoint.hash
    || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)
    || !id || !secreto || !/^[\w-]+$/.test(region)) {
    throw new Error(`Configuración incompleta o inválida de ${prefijo}_BUCKET.`);
  }
  return { endpoint: endpoint.origin, bucket, id, secreto, region };
}

export function comprobarSeparacion(copias, medios) {
  if ((copias.endpoint === medios.endpoint && copias.bucket === medios.bucket) || copias.id === medios.id) {
    throw new Error("Los buckets de copias y medios deben tener destinos y credenciales independientes.");
  }
}

export function s3(config, args, capturar = false) {
  return ejecutar("aws", ["--no-cli-pager", "--region", config.region, "--endpoint-url", config.endpoint, ...args], {
    capturar,
    variables: {
      AWS_ACCESS_KEY_ID: config.id,
      AWS_SECRET_ACCESS_KEY: config.secreto,
      AWS_EC2_METADATA_DISABLED: "true",
      AWS_REQUEST_CHECKSUM_CALCULATION: "WHEN_REQUIRED",
      AWS_RESPONSE_CHECKSUM_VALIDATION: "WHEN_REQUIRED",
    },
  });
}

export function uri(config, llave = "") {
  return `s3://${config.bucket}/${llave}`;
}

export async function huella(ruta) {
  const hash = createHash("sha256");
  for await (const trozo of createReadStream(ruta)) hash.update(trozo);
  return { sha256: hash.digest("hex"), bytes: (await stat(ruta)).size };
}

export async function coincide(ruta, esperado) {
  const actual = await huella(ruta);
  return actual.sha256 === esperado.sha256 && actual.bytes === esperado.bytes;
}

export async function comprobarEspacio(dir, bytes) {
  const { bavail, bsize } = await statfs(dir);
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes + 256 * 1024 ** 2 > bavail * bsize) {
    throw new Error("Espacio temporal insuficiente o tamaño de copia inválido.");
  }
}
