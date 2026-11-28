import { copiaPostgres } from "./respaldo.mjs";
import { copiarMedios, protegerMedios, limpiarMedios } from "./medios.mjs";

const [operacion, id, confirmacion, confirmado, ...extra] = process.argv.slice(2);
try {
  if (extra.length || (operacion !== "medios-limpiar" && id)) throw new Error("Argumentos inválidos.");
  let resultado;
  switch (operacion) {
    case "postgres":
      resultado = await copiaPostgres();
      break;
    case "medios-proteger":
      resultado = await protegerMedios();
      break;
    case "medios-inventario":
    case "medios-copiar":
      resultado = await copiarMedios(operacion === "medios-inventario");
      break;
    case "medios-limpiar":
      if (!id || confirmacion !== "--confirm" || confirmado !== id) {
        throw new Error("Usa medios-limpiar ID --confirm ID tras el ensayo de restauración.");
      }
      resultado = await limpiarMedios(id);
      break;
    default:
      throw new Error("Usa postgres, medios-proteger, medios-inventario, medios-copiar o medios-limpiar.");
  }
  console.log(JSON.stringify(resultado));
} catch (error) {
  console.error(error instanceof Error ? error.message : "Falló la operación.");
  process.exitCode = 1;
}
