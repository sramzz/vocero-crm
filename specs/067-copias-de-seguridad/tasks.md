# Tareas 067 — Copias gestionadas por Coolify

- [x] **T001 · Elegir el mecanismo.** Staging usa PostgreSQL dentro de una aplicación Compose, sin un recurso de base registrado en el MCP de Coolify.
- [x] **T002 · Retirar el programador anterior.** Quitar la pantalla y el ejecutor del host conservando la migración ya desplegada y los medios.
- [x] **T003 · Implementar la copia PostgreSQL.** Dump, verificación de catálogo, subida privada, verificación de bytes y manifiesto final.
- [x] **T004 · Implementar la operación de medios.** Copia independiente, inventario, traslado con verificación y limpieza confirmada.
- [x] **T005 · Desplegar y ejecutar en staging.** Tarea `Vocero PostgreSQL → R2`, credenciales separadas y frecuencia `0 */8 * * *` en UTC. Primera ejecución manual verificada en R2.
- [x] **T006 · Restaurar en PostgreSQL desechable.** Dump real restaurado en PostgreSQL 16.16 con 45 tablas de Vocero y Nea. Staging estaba vacío. La prueba posterior pobló solo una instancia aislada y comprobó la conversación y los bytes del adjunto por su enlace original.
- [x] **T007 · Ensayar el traslado.** La copia de medios protegió un archivo sintético. Dos ejecuciones verificaron la misma clave en R2. Tras recuperar y comparar los bytes, la limpieza eliminó un archivo del directorio de ensayo.
- [ ] **T008 · Activar retención automática de PostgreSQL.** Pendiente de la autorización para expirar objetos tras 30 días, solo en el prefijo `postgres/` de staging.

## Evidencia de staging

- SHA desplegado y verificado `528845b`. La aplicación mantuvo la salud y el acceso a medios durante la copia.
- Copia PostgreSQL `2026-11-28T19-00-08-046Z-16d60694-0550-436b-ae9c-a0daeb519311`. Coolify registró cinco segundos; el SHA-256 del dump remoto coincidió con el manifiesto.
- Una ejecución de ensayo con una credencial S3 inválida terminó en error en Coolify. R2 conservó el dump y el manifiesto anteriores, sin publicar otro conjunto.
- Copia de medios `2026-11-28T19-03-32-625Z-a0532cd7-fda4-47e0-b6ef-61e7d6f5f764`. El archivo recuperado coincidió con el objeto trasladado en R2. La prueba aislada también comprobó que un objeto alterado bloquea la limpieza.
- [Guion del ensayo](../../tests/e2e/us-copias-coolify.md).
