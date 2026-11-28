"use client";

import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import type { HorarioCopias } from "@/lib/copias-horario";
import type { leerProgramacion } from "@/server/copias/programacion";

const frecuencias = { "8h": "Cada 8 horas", "12h": "Cada 12 horas", diaria: "Diaria", semanal: "Semanal" };
const dias = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"];
const resultados = { en_curso: "En curso", completa: "Verificada", fallida: "Fallida", omitida: "Omitida" };
const fechaUtc = new Intl.DateTimeFormat("es", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });

type Estado = Awaited<ReturnType<typeof leerProgramacion>>;

function fecha(valor: string | null) {
  return valor ? `${fechaUtc.format(new Date(valor))} UTC` : "—";
}

export function CopiasClient({ inicial }: { inicial: Estado }) {
  const [estado, setEstado] = useState(inicial);
  const [horario, setHorario] = useState(inicial.horario);
  const [guardando, setGuardando] = useState(false);
  const [mensaje, setMensaje] = useState("");
  const control = "rounded-md border bg-background px-3 py-2";

  async function guardar(evento: FormEvent<HTMLFormElement>) {
    evento.preventDefault();
    setGuardando(true);
    setMensaje("");
    try {
      const respuesta = await fetch("/api/settings/backups", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(horario),
      });
      if (!respuesta.ok) {
        const datos = await respuesta.json().catch(() => null);
        throw new Error(datos?.error?.message ?? "No se pudo guardar.");
      }
      const nuevo: Estado = await respuesta.json();
      setEstado(nuevo);
      setHorario(nuevo.horario);
      setMensaje("Programación guardada.");
    } catch (error) {
      setMensaje(error instanceof Error ? error.message : "No se pudo guardar.");
    } finally {
      setGuardando(false);
    }
  }

  return (
    <section className="max-w-xl space-y-5">
      <h1 className="text-xl font-semibold">Copias de seguridad</h1>
      {!estado.conectado && <p className="text-sm text-muted-foreground">El ejecutor está desconectado. Pide al operador que configure las copias en el servidor.</p>}
      <dl className="space-y-1 text-sm">
        <div><dt className="inline font-medium">Próxima copia: </dt><dd className="inline">{fecha(estado.siguiente)}</dd></div>
        <div><dt className="inline font-medium">Última copia verificada: </dt><dd className="inline">{fecha(estado.ultimaVerificada)}</dd></div>
        <div><dt className="inline font-medium">Último contacto del ejecutor: </dt><dd className="inline">{fecha(estado.ultimoContacto)}</dd></div>
        <div><dt className="inline font-medium">Último resultado: </dt><dd className="inline">{estado.resultado ? resultados[estado.resultado] : "—"}</dd></div>
      </dl>
      <form className="space-y-4" onSubmit={guardar}>
        <fieldset className="space-y-4" disabled={guardando}>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={horario.habilitada} disabled={!estado.conectado && !horario.habilitada}
              onChange={(e) => setHorario({ ...horario, habilitada: e.target.checked })} />
            Habilitar copias programadas
          </label>
          <div className="flex flex-wrap gap-4">
            <label className="flex flex-col gap-1 text-sm">
              Frecuencia
              <select className={control} value={horario.frecuencia} onChange={(e) => {
                const frecuencia = e.target.value as HorarioCopias["frecuencia"];
                setHorario({ ...horario, frecuencia, dia: frecuencia === "semanal" ? 1 : null });
              }}>
                {Object.entries(frecuencias).map(([valor, etiqueta]) => <option key={valor} value={valor}>{etiqueta}</option>)}
              </select>
            </label>
            {horario.frecuencia === "semanal" && <label className="flex flex-col gap-1 text-sm">
              Día
              <select className={control} value={horario.dia ?? 1} onChange={(e) => setHorario({ ...horario, dia: Number(e.target.value) })}>
                {dias.map((dia, i) => <option key={dia} value={i}>{dia}</option>)}
              </select>
            </label>}
            <label className="flex flex-col gap-1 text-sm">
              Hora de inicio (UTC)
              <input className={control} type="time" required value={horario.horaUtc}
                onChange={(e) => setHorario({ ...horario, horaUtc: e.target.value })} />
            </label>
          </div>
          <p className="text-sm text-muted-foreground">La captura interrumpe el servicio brevemente. Elige un horario compatible con la operación.</p>
          <Button type="submit" disabled={!estado.conectado && (horario.habilitada || !estado.horario.habilitada)}>
            {guardando ? "Guardando…" : "Guardar programación"}
          </Button>
        </fieldset>
        <p className="text-sm" role="status">{mensaje}</p>
      </form>
    </section>
  );
}
