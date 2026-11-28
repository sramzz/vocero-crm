# Ensayo 067 — Copias desde Coolify

Usar staging con datos sintéticos y una base de restauración desechable. Ver [la guía](../../docs/copias-de-seguridad.md).

1. Registrar el SHA visible en la salud, el modo bucket, y los contenedores `app`, `postgres` y `nea` existentes.
2. Ejecutar la tarea PostgreSQL con la aplicación sirviendo peticiones. Comprobar el éxito en Coolify, el SHA-256 del archivo y el manifiesto publicado en R2. Confirmar que Coolify conserva el horario cada ocho horas. Provocar un fallo una vez en un destino de prueba con un token sin permisos. Confirmar que no se publica un manifiesto nuevo y que la copia previa sigue disponible.
3. Restaurar desde R2 en la base vacía y aislada. Comprobar una conversación sintética y sus archivos en Vocero con la mensajería real desactivada.
4. Crear un adjunto local y otro en el bucket de prueba. Restringir escrituras de medios. Ensayar inventario, protección y traslado. Repetir el traslado. Verificar que el archivo original se abre después de ambas ejecuciones y que un objeto distinto impide sobrescribirlo.
5. Recuperar el archivo de protección en un destino aislado. Tras confirmar los bytes y los enlaces originales, ejecutar la limpieza con el ID confirmado. Comprobar que el inventario local queda vacío, el volumen sigue montado y ambos adjuntos siguen disponibles.
