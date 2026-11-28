# Tareas — Copias de seguridad y restauración

**Spec** [spec.md](spec.md) · **Plan** [plan.md](plan.md)

## Implementación local

T001 a T010 están implementadas en el commit `ebf325e` de `main`. Cada casilla secundaria registra la validación que falta para aceptar esa tarea.

- [x] **T001 · Medios en Coolify.** Pasar las variables de 037 solo en ejecución. **CA-3**
  - [ ] Verificar cuatro escenarios con archivos de prueba: disco sin bucket, archivo nuevo en bucket privado, archivo histórico servido desde disco y escritura en disco al fallar el bucket.
- [x] **T002 · Prevalidación y exclusión mutua.** Implementar `backup --instance <uuid>`. Resolver los recursos del UUID, comprobar espacio, medios y destino remoto, y adquirir el bloqueo. **CA-1, CA-6**
  - [ ] Comprobar que un UUID ambiguo, una configuración parcial, un despliegue activo o una copia simultánea abortan con un diagnóstico antes de detener servicios.
- [x] **T003 · Captura y reanudación.** Depende de T002. Registrar los servicios activos, detener los escritores y capturar el dump completo, `/data` y el bucket configurado. **CA-1, CA-2**
  - [ ] Comprobar que fallar el dump, fallar cualquiera de las copias de medios, exceder el plazo o interrumpir el proceso hace que los servicios activos vuelvan y no se publique un conjunto. Probar también la reconciliación con un registro pendiente.
- [x] **T004 · Publicación y retención.** Depende de T003. Subir los componentes y verificar su integridad antes de publicar el manifiesto. **CA-2**
  - [ ] Comprobar que una subida interrumpida o un archivo remoto corrupto deja el conjunto fuera de la lista de restauración y la última copia válida se conserva. Probar la retención con conjuntos vencidos.
- [x] **T005 · Programación desde Vocero.** Añadir la migración, el endpoint interno y la pantalla **Configuración → Copias de seguridad**. Verificar que `owner` y `admin` pueden guardar y pausar, que los miembros sin permisos no pueden leer ni escribir, y que otra organización no puede consultar ni modificar el horario. Probar valores inválidos, servicio desconectado y el cálculo de la próxima ejecución de cada frecuencia. **CA-7**
- [x] **T006 · Ejecutor y avisos.** Depende de T004 y T005. Consultar la programación desde el host y ejecutar cada turno una vez. **CA-6, CA-7**
  - [ ] Verificar en staging que cambiar la frecuencia en la UI cambia el siguiente turno sin redespliegue, que pausar no interrumpe una captura activa y que los turnos vencidos no disparan una pausa fuera de horario. Probar copia manual, solapamiento y avisos con reloj simulado, incluidas 10 h para la frecuencia inicial de 8 h y 26 h para la diaria. Verificar tres turnos en un día UTC y el cruce de medianoche con una hora de inicio distinta de la sugerida.
- [x] **T007 · Restauración aislada.** Depende de T004 a T006. Implementar `restore --source <uuid> --backup <id> --target <uuid>` y validar todos los componentes antes de escribir. **CA-4, CA-5**
  - [ ] Comprobar que se rechazan una copia incompleta o alterada, otra clave, un destino con datos y un recurso compartido. Una restauración parcial mantiene el destino apagado y el horario del origen no se ejecuta en el destino.
- [x] **T008 · Copia verificada de medios.** Depende de T001 a T004. Inventariar los medios locales, contrastar referencias activas y copiar con las claves actuales. **CA-8**
  - [ ] Comprobar que el simulacro no escribe, dos ejecuciones producen el mismo inventario verificado, un objeto distinto nunca se sobrescribe y una copia parcial no elimina archivos locales. Probar adjuntos, logos, iconos, archivos de contingencia y rutas inválidas.
- [x] **T009 · Limpieza confirmada.** Depende de T007 y T008. Implementar la limpieza por manifiesto con comprobación de la copia restaurable y confirmación explícita. **CA-8**
  - [ ] Comprobar que un objeto ausente, alterado o un archivo local nuevo bloquea la limpieza, y una ejecución válida elimina solo medios locales verificados. Probar interrupción y reanudación.
- [x] **T010 · Runbook de operador.** Depende de T001 a T009. Documentar el alta del ejecutor, el horario en Vocero, la copia y restauración, y el traslado seguido de la limpieza de medios. Incluir comprobaciones previas, tratamiento de conflictos, custodia de secretos, recuperación de servicios y verificación posterior. **CA-1 a CA-8**

## Verificación

- [x] **Pruebas locales.** `pnpm typecheck`, `pnpm lint`, `pnpm test` (1.466 pruebas) y `pnpm build`. El ensayo con Chromium y PostgreSQL desechable verificó guardar, recargar y pausar el horario.
- [x] **Pruebas simuladas del ejecutor.** Reanudación de escritores al fallar la captura, preparación del bucket antes de la pausa, conservación de la última copia válida ante una subida interrumpida y bloqueo del borrado si falta la certificación o cambia el objeto.
- [ ] **T011 · Ensayo en staging.** Depende de T010. Completar las validaciones pendientes de T001 a T009 con datos sintéticos. Medir tres capturas completas, cambiar el horario desde Vocero y restaurar una copia remota en una instancia desechable. Verificar el descifrado, los medios de ambos orígenes y la ausencia de mensajería real. Completar el traslado y la limpieza en staging y volver a abrir los adjuntos originales. Registrar SHA, duración de las pausas, tiempos de media antes y después y resultado de la restauración antes de proponer el despliegue. **CA-1 a CA-8**
