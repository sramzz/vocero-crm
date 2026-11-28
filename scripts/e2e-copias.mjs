import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import postgres from "postgres";
import { chromium } from "playwright";

/** Ejecuta contra una base de prueba local recién migrada y un build de Next. */
const url = new URL(process.env.COPIAS_E2E_DATABASE_URL ?? "postgresql://invalid");
assert.ok(["127.0.0.1", "localhost"].includes(url.hostname) && /^\/vocero_copias_e2e_[a-f0-9]+$/.test(url.pathname),
  "Configura COPIAS_E2E_DATABASE_URL con una base local desechable.");
const port = 3037;
const base = `http://127.0.0.1:${port}`;
const instancia = "local-copias-e2e";
const directorio = await mkdtemp(join(tmpdir(), "vocero-copias-media-"));
const cwd = resolve(process.env.COPIAS_E2E_BUILD || ".");
const env = {
  PATH: process.env.PATH,
  HOSTNAME: "127.0.0.1",
  PORT: String(port),
  NODE_ENV: "production",
  DATABASE_URL: url.toString(),
  APP_BASE_URL: base,
  BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
  ENCRYPTION_KEY: randomBytes(32).toString("base64"),
  META_WEBHOOK_VERIFY_TOKEN: randomBytes(32).toString("hex"),
  MEDIA_DIR: directorio,
  COPIAS_INSTANCIA_ID: instancia,
};
const sql = postgres(url.toString(), { connection: { TimeZone: "UTC" } });
let server;
let browser;

try {
  const [fila] = await sql`select count(*)::int as total from organization`;
  assert.equal(fila.total, 0, "La base de prueba debe estar vacía.");
  server = spawn(process.execPath, [".next/standalone/server.js"], {
    cwd, env, stdio: ["ignore", "ignore", "inherit"],
  });
  for (let i = 0; i < 30; i += 1) {
    assert.equal(server.exitCode, null, "Next se detuvo.");
    const healthy = await fetch(`${base}/api/health`).then((r) => r.ok).catch(() => false);
    if (healthy) break;
    if (i === 29) throw new Error("El servidor de prueba no respondió.");
    await new Promise((r) => setTimeout(r, 500));
  }
  browser = await chromium.launch();
  const ctx = await browser.newContext({ baseURL: base });
  const h = { origin: base };
  const anónimo = await ctx.request.get("/api/settings/backups");
  assert.equal(anónimo.status(), 401);
  const alta = await ctx.request.post("/api/auth/sign-up/email", {
    headers: h, data: { email: "copias@vocero.test", password: randomBytes(16).toString("hex"), name: "Pruebas de copias" },
  });
  assert.ok(alta.ok(), `Alta de prueba HTTP ${alta.status()}`);
  const obtenido = await ctx.request.get("/api/settings/backups");
  assert.equal(obtenido.status(), 200);
  const inicial = await obtenido.json();
  assert.equal(inicial.conectado, false);
  const [org] = await sql`select id from organization`;
  await sql`insert into copia_estado (organization_id, instancia_id, contacto) values (${org.id}, ${instancia}, now())`;

  const page = await ctx.newPage();
  page.on("pageerror", (error) => console.error("Error de navegador:", error.message));
  await page.goto("/settings/backups");
  await page.getByRole("heading", { name: "Copias de seguridad" }).waitFor();
  await page.getByLabel("Habilitar copias programadas").check();
  await page.getByLabel("Frecuencia").selectOption("semanal");
  await page.getByRole("combobox", { name: /^Día/ }).selectOption("4");
  await page.getByLabel("Hora de inicio (UTC)").fill("17:35");
  await page.getByRole("button", { name: "Guardar programación" }).click();
  await page.getByText("Programación guardada.").waitFor();
  const guardado = await (await ctx.request.get("/api/settings/backups")).json();
  assert.deepEqual(guardado.horario, { habilitada: true, frecuencia: "semanal", horaUtc: "17:35", dia: 4 });
  assert.ok(guardado.siguiente);
  await page.reload();
  assert.equal(await page.getByLabel("Frecuencia").inputValue(), "semanal");
  await page.getByLabel("Habilitar copias programadas").uncheck();
  await page.getByRole("button", { name: "Guardar programación" }).click();
  await page.getByText("Programación guardada.").waitFor();
  const pausado = await (await ctx.request.get("/api/settings/backups")).json();
  assert.equal(pausado.horario.habilitada, false);
  assert.equal(pausado.siguiente, null);
  console.log("067 — PostgreSQL y navegador: alta, estado del ejecutor, guardar, recargar y pausar.");
} finally {
  await browser?.close();
  if (server && server.exitCode === null) {
    const cerrado = once(server, "exit");
    server.kill();
    await cerrado;
  }
  await sql.end({ timeout: 2 });
  await rm(directorio, { recursive: true, force: true });
}
