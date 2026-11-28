# 067 — Copias de seguridad y restauración

**Estado**: Especificada antes de escribir código. Implementación local con verificación de la interfaz y PostgreSQL. Pendiente ensayo de almacenamiento remoto y restauración en Coolify staging.

**Carril**: Ciclo completo. Añade una integración operativa opcional de copias fuera del servidor y guarda la programación por instancia. [Plan](plan.md) · [Tareas](tasks.md)

## Problema

Cada instancia de Vocero conserva su base y sus adjuntos en volúmenes persistentes. Para recuperar una instancia después de perder el servidor, el operador necesita una copia verificable de los datos y los archivos, además de acceso a las claves de restauración.

## Historias

- **H1 — Operar copias por instancia.** En **Configuración → Copias de seguridad**, el propietario o administrador puede habilitar, pausar o cambiar la frecuencia y la hora de las copias. Al habilitarlas por primera vez, la frecuencia inicial es de tres copias al día, separadas por ocho horas. Un operador puede solicitar una copia manual por CLI antes de un despliegue con migraciones. Cada copia incluye la base completa de Vocero, incluido el esquema de Nea si existe, `/data` y los objetos del bucket de medios si está configurado y puede contener archivos. El destino remoto conserva 30 días de copias. Los secretos se custodian por separado.
- **H2 — Centralizar los medios en el bucket.** Una vez configurado el bucket S3 compatible privado de una instancia, los archivos nuevos se guardan allí. El operador traslada los medios del volumen, verifica la copia y confirma la limpieza local. Los adjuntos conservan su enlace. El volumen queda disponible para escrituras de contingencia durante una incidencia del bucket. Al restablecerse, el operador puede vaciarlo con el mismo flujo verificado.
- **H3 — Recuperar una instancia.** El operador restaura un conjunto verificado mediante CLI en una instancia aislada, con base vacía y almacenamiento exclusivo. Puede revisar conversaciones y abrir adjuntos sin que la instancia restaurada envíe mensajes ni procese tráfico de producción.

## Criterios de aceptación

- **CA-1.** La captura se hace durante una ventana programada sin escrituras de los servicios. El servicio se reanuda antes de la transferencia remota, incluso si la captura falla.
- **CA-2.** Cada conjunto completo identifica la instancia, la revisión desplegada, la fecha y los componentes con verificación de integridad. Los fallos se muestran al operador, no publican un conjunto como completo y conservan la última copia válida.
- **CA-3.** En modo disco se pueden guardar y abrir adjuntos. En modo bucket se verifica un archivo nuevo en el bucket, un adjunto histórico en disco y un archivo que se guardó en disco durante una caída del bucket. El acceso sigue limitado a la organización autorizada.
- **CA-4.** En staging, una restauración aislada recupera conversaciones y ejemplos de imagen, nota de voz, video y documento desde ambos almacenamientos. Una credencial de prueba se puede descifrar con la clave original. El ensayo no envía mensajes ni usa integraciones de producción.
- **CA-5.** Una restauración rechaza un conjunto incompleto o con fallos de integridad, una clave de restauración incorrecta y un destino que no esté vacío o aislado.
- **CA-6.** La programación y la orden manual inician el mismo proceso. Si se solapan, solo se ejecuta una copia. Los cambios de datos no disparan copias. Se avisa al fallar, superar el plazo o vencer el margen de frescura de la frecuencia elegida. La recuperación llega a la última captura completa. Con la frecuencia inicial funcionando, se pueden perder alrededor de ocho horas de cambios. Una ejecución fallida puede ampliar ese intervalo.
- **CA-7.** Un propietario o administrador puede guardar una frecuencia cada 8 horas, cada 12 horas, diaria o semanal, elegir la hora de inicio y ver la próxima ejecución en UTC sin redesplegar. La pantalla muestra si el servicio de copias está conectado y cuándo terminó la última copia verificada. Una instancia sin servicio configurado muestra cómo habilitarlo. Un miembro sin permisos no puede consultar ni cambiar la programación. Pausar o editar el horario afecta a ejecuciones futuras y no cancela la que esté en curso.
- **CA-8.** Tras configurar el bucket, el operador puede inventariar, copiar y verificar todos los medios locales, incluidos adjuntos, logos e iconos. Una copia fallida, un conflicto de contenido o un archivo ausente impiden la limpieza. Solo se eliminan archivos locales verificados después de una confirmación explícita y con una copia recuperable. Los adjuntos se pueden abrir por sus enlaces originales después de limpiar el volumen.

## Fuera de alcance

Cambiar credenciales o destinos de copia desde Vocero, iniciar copias manuales o restauraciones desde la interfaz, cambiar las API públicas, copiar por cada cambio, archivar WAL continuamente, recuperar a un instante arbitrario y restaurar automáticamente sobre producción.

## Referencias

- [Vocero 037 · Almacenamiento opcional](../037-almacenamiento/spec.md)
- [Rocket.Chat · Copia y restauración de MongoDB](https://docs.rocket.chat/docs/mongodb-backup-and-restore)
- [Rocket.Chat · Almacenamiento de archivos](https://docs.rocket.chat/docs/file-storage)
- [PostgreSQL 16 · Archivado continuo y recuperación a un instante](https://www.postgresql.org/docs/16/continuous-archiving.html)
