#!/usr/bin/env node
import { mkdir, lstat, open } from "node:fs/promises";
import { spawn } from "node:child_process";
import { ZodError } from "zod";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import postgres from "postgres";
import { horarioCopiasSchema, intervaloCopias, MARGEN_HORARIO_MS, timestampCopiasUtc, turnosCopias } from "../../src/lib/copias-horario.ts";
import { idSeguro, leerConfig } from "./infra.mjs";
import { backup, certificar, mediaMigrate, reanudar, restore } from "./operaciones.mjs";

const control = new AbortController();
for (const señal of ["SIGINT", "SIGTERM"]) process.once(señal, () => control.abort());
const señal = control.signal;
const base = resolve(process.env.COPIAS_ESTADO || "/var/lib/vocero-copias");
const archivo = process.env.COPIAS_CONFIG || "/etc/vocero-copias/instancias.json";

async function bloquear(uuid, fn) {
  const fd = await open(join(base, `${uuid}.lock`), "a", 0o600);
  try {
    // flock hereda el descriptor de la misma descripción de archivo abierta por Node.
    await new Promise((ok, error) => {
      const child = spawn("flock", ["-n", "3"], { stdio: ["ignore", "ignore", "ignore", fd.fd] });
      child.once("error", () => error(new Error("No se pudo ejecutar flock.")));
      child.once("exit", (code) => code === 0 ? ok() : error(new Error("Ya hay una operación para esta instancia.")));
    });
    return await fn();
  } finally {
    await fd.close();
  }
}

function conexion(cfg) {
  if (!cfg.conexionOperativa) throw new Error("Falta la conexión operativa.");
  return postgres(cfg.conexionOperativa, { max: 1, connect_timeout: 5, idle_timeout: 10,
    onnotice: () => {},
    // PostgreSQL no incluye zona en OID 1114. El host puede estar en otra zona.
    types: { timestampUtc: { to: 1114, from: [1114], serialize: (v) => new Date(v).toISOString(),
      parse: timestampCopiasUtc } },
    connection: { TimeZone: "UTC", statement_timeout: "8000" } });
}

function utc(fecha) {
  return fecha instanceof Date ? fecha.toISOString() : fecha;
}

async function actualizar(sql, ctx, datos) {
  const { uuid, cfg } = ctx;
  await sql`update copia_estado set ${sql(datos)} where organization_id = ${cfg.organizacion} and instancia_id = ${uuid}`;
}

async function ejecutarCopia(ctx, sql, turno = null) {
  const inicio = Date.now();
  if (sql) await actualizar(sql, ctx, { resultado: "en_curso" });
  let actualizando = Promise.resolve();
  const latido = sql && setInterval(() => {
    actualizando = actualizando.then(() => actualizar(sql, ctx, { contacto: new Date() })).catch(() => {});
  }, 60_000);
  try {
    const resultado = await backup(ctx, señal);
    if (sql) await actualizar(sql, ctx, {
      resultado: "completa", ultima_captura: resultado.capturada, ultima_verificada: resultado.verificada, aviso_desde: null,
    });
    console.log(JSON.stringify({ instancia: ctx.uuid, turno, ...resultado, duracionMs: Date.now() - inicio }));
    return resultado;
  } catch (e) {
    if (sql) await actualizar(sql, ctx, { resultado: "fallida" }).catch(() => {});
    console.error(JSON.stringify({ instancia: ctx.uuid, turno, resultado: "fallida", duracionMs: Date.now() - inicio }));
    throw e;
  } finally {
    if (latido) clearInterval(latido);
    await actualizando;
  }
}

async function contactar(sql, ctx) {
  return sql`insert into copia_estado (organization_id, instancia_id, contacto)
    values (${ctx.cfg.organizacion}, ${ctx.uuid}, now())
    on conflict (organization_id, instancia_id) do update set contacto=excluded.contacto returning *`;
}

async function programar(ctx) {
  const { cfg, uuid } = ctx;
  if (cfg.destinoPrueba || !cfg.conexionOperativa) return;
  const sql = conexion(cfg);
  try {
    const [estado] = await contactar(sql, ctx);
    const [fila] = await sql`select habilitada, frecuencia, hora_utc, dia, desde
      from copia_programacion where organization_id=${cfg.organizacion} and instancia_id=${uuid}`;
    if (!fila?.habilitada) return;
    const horario = horarioCopiasSchema.parse({ habilitada: fila.habilitada, frecuencia: fila.frecuencia, horaUtc: fila.hora_utc, dia: fila.dia });
    const ahora = new Date();
    const { anterior, siguiente } = turnosCopias(horario, ahora);
    const desde = new Date(utc(fila.desde));
    const ultima = estado.ultima_captura ? new Date(utc(estado.ultima_captura)) : null;
    const primerTurno = turnosCopias(horario, desde).siguiente;
    const baseAviso = ultima && ultima > desde ? new Date(ultima.getTime() + intervaloCopias(horario)) :
      ultima ? new Date(Math.min(primerTurno.getTime(), Math.max(desde.getTime(), ultima.getTime() + intervaloCopias(horario)))) : primerTurno;
    if (ahora.getTime() - baseAviso.getTime() > 7_200_000
      && (!estado.aviso_desde || utc(estado.aviso_desde) !== baseAviso.toISOString())) {
      await actualizar(sql, ctx, { aviso_desde: baseAviso });
      console.error(JSON.stringify({ instancia: uuid, resultado: "copia_atrasada", ultimaCaptura: utc(estado.ultima_captura) }));
    }
    if (anterior <= desde || (estado.turno && new Date(utc(estado.turno)) >= anterior)) return;
    const bloqueada = await bloquear(uuid, async () => {
      // Revalidar en la misma escritura el horario, para no ejecutar una edición o pausa concurrente.
      const omitida = Date.now() - anterior.getTime() >= MARGEN_HORARIO_MS;
      const [tomado] = await sql`update copia_estado e
        set turno=${anterior}, resultado=${omitida ? "omitida" : "en_curso"}
        where e.organization_id=${cfg.organizacion} and e.instancia_id=${uuid}
          and (e.turno is null or e.turno < ${anterior})
          and exists (select 1 from copia_programacion p where p.organization_id=e.organization_id
            and p.instancia_id=e.instancia_id and p.habilitada and p.desde=${desde})
        returning e.turno`;
      if (!tomado) return;
      if (omitida) {
        console.error(JSON.stringify({ instancia: uuid, turno: anterior.toISOString(), siguiente: siguiente.toISOString(), resultado: "omitida" }));
        return;
      }
      // La unidad anfitriona puede reconciliar el diario aunque este proceso se interrumpa.
      await reanudar(base, uuid);
      await ejecutarCopia(ctx, sql, anterior.toISOString());
    }).catch((e) => {
      console.error(JSON.stringify({ instancia: uuid, error: errorSeguro(e) }));
      return false;
    });
    if (bloqueada === false) process.exitCode = 1;
  } finally { await sql.end({ timeout: 5 }); }
}

async function main() {
  if (process.argv.slice(2).join(" ") === "--help") {
    console.log("Comandos: backup --instance UUID | restore --source UUID --backup ID --target UUID | restore-verify | media-migrate | reanudar");
    return;
  }
  const { positionals: [op, ...otros], values: v } = parseArgs({
    allowPositionals: true,
    options: {
      instance: { type: "string" }, source: { type: "string" }, backup: { type: "string" }, target: { type: "string" },
      "dry-run": { type: "boolean" }, copy: { type: "boolean" }, prune: { type: "boolean" },
      manifest: { type: "string" }, confirm: { type: "string" },
    },
  });
  if (otros.length || !["backup", "restore", "restore-verify", "media-migrate", "tick", "reanudar"].includes(op)) {
    throw new Error("Usa backup, restore, restore-verify, media-migrate, tick o reanudar.");
  }
  const config = await leerConfig(archivo);
  await mkdir(base, { recursive: true, mode: 0o700 });
  const carpeta = await lstat(base);
  if (!carpeta.isDirectory() || (carpeta.mode & 0o077) !== 0) throw new Error("El estado requiere un directorio privado.");
  const contexto = (uuid) => {
    const cfg = Object.hasOwn(config.instancias, uuid) && config.instancias[uuid];
    if (!cfg) throw new Error("UUID no provisionado.");
    return { base, uuid, cfg, config };
  };
  if (op === "tick") return programar(contexto(idSeguro.parse(v.instance)));
  const uuid = idSeguro.parse(["restore", "restore-verify"].includes(op) ? v.target : v.instance);
  const ctx = contexto(uuid);
  const salida = await bloquear(uuid, async () => {
    if (op === "restore") return restore(ctx, idSeguro.parse(v.source), idSeguro.parse(v.backup), señal);
    if (op === "restore-verify") {
      if (v.confirm !== uuid) throw new Error("Certifica solo después del ensayo con --confirm y el UUID del destino.");
      return certificar(ctx, idSeguro.parse(v.source), idSeguro.parse(v.backup));
    }
    if (op === "reanudar" || op === "backup") await reanudar(base, uuid);
    if (op === "reanudar") return { estado: "servicios_revisados" };
    if (op === "backup") {
      const sql = ctx.cfg.conexionOperativa ? conexion(ctx.cfg) : null;
      try {
        if (sql) await contactar(sql, ctx);
        await ejecutarCopia(ctx, sql);
        return null;
      } finally { if (sql) await sql.end({ timeout: 5 }); }
    }
    const modos = ["dry-run", "copy", "prune"].filter((m) => v[m]);
    if (modos.length !== 1) throw new Error("Indica exactamente uno de --dry-run, --copy o --prune.");
    const id = modos[0] === "prune" ? idSeguro.parse(v.manifest) : undefined;
    const respaldo = modos[0] === "copy" ? idSeguro.parse(v.backup) : undefined;
    if (id && v.confirm !== uuid) throw new Error("La limpieza requiere --confirm con el UUID exacto.");
    if (modos[0] !== "dry-run") await reanudar(base, uuid);
    return mediaMigrate(ctx, modos[0], id, respaldo, señal);
  });
  if (salida) console.log(JSON.stringify({ instancia: uuid, ...salida }));
}

main().catch((e) => {
  // Los errores del driver, Docker y AWS pueden contener parámetros privados.
  console.error(e instanceof ZodError ? "Argumentos inválidos." : errorSeguro(e));
  process.exitCode = 1;
});

function errorSeguro(e) {
  if (e instanceof ZodError) return "La entrada o el manifiesto no son válidos.";
  if (!(e instanceof Error) || Object.hasOwn(e, "code")) return "Falló la operación. Revisa el estado de la instancia.";
  return e.message;
}
