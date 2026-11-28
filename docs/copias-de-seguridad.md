# Copias, restauración y traslado de medios

La programación se administra en **Configuración → Copias de seguridad**. El ejecutor vive en el host Linux de Coolify y usa el UUID de cada aplicación. El valor inicial al habilitar es cada 8 horas en UTC. Cada ejecución prepara una copia completa y verificada de PostgreSQL, del volumen y del bucket de medios configurado. Una copia incompleta no se anuncia como restaurable.

## Preparar el ejecutor

1. En el host de despliegue, instala Node 22, Docker CLI, util-linux (`flock`), GNU tar y AWS CLI v2 con soporte para `s3api put-object --if-none-match`. Compila desde la revisión aprobada y copia solo el ejecutable y las unidades al host:

   ```bash
   pnpm exec esbuild scripts/copias/cli.mjs --bundle --platform=node --format=esm \
     --banner:js="import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" \
     --outfile=tmp/vocero-copias/cli.mjs
   ```

2. En el host, como operador, instala el ejecutable en `/opt/vocero-copias/cli.mjs` y comprueba que `/usr/bin/node` ejecuta Node 22. Usa permisos `0700` en `/etc/vocero-copias` y `/var/lib/vocero-copias`, `0600` para sus archivos, y un disco temporal con espacio suficiente para la captura completa. Por defecto se usa el directorio temporal del host. Se puede fijar otro con `COPIAS_TEMPORAL` en la unidad y en las operaciones manuales.
3. Copia [instancias.example.json](../scripts/copias/instancias.example.json) a `/etc/vocero-copias/instancias.json`. Registra el UUID, la organización local y el usuario local de PostgreSQL. En Coolify habilita **Advanced → Build → Source commit availability** y verifica que la imagen trae la revisión completa. El ejecutor contrasta esa revisión con la del contenedor. El campo opcional `revision` fija un SHA y es útil en destinos de prueba. Calcula la huella SHA-256 de los **32 bytes decodificados** de `ENCRYPTION_KEY` en una terminal segura y registra la referencia de la versión en el gestor de secretos. Conserva la clave original, las credenciales y la configuración de restauración por separado.
4. Habilita acceso a la REST API de Coolify para un token de lectura con alcance sobre las aplicaciones provisionadas, y guarda el token en el JSON privado. El CLI comprueba despliegues activos antes de detener servicios. Mantén las actualizaciones manuales y evita cambios en Coolify durante la captura. Provisiona un destino S3 compatible **fuera del host**, privado, con soporte para cifrado AES256 y multipart. Configura una regla de expiración solo para cargas multipart incompletas. El ejecutor administra el vencimiento de conjuntos completos. El perfil del ejecutor necesita listar, leer, escribir y aplicar retención. Cada bucket de medios es exclusivo de una instancia y usa un perfil distinto. Comprueba la compatibilidad y el espacio en staging antes de programar producción.
   Para Cloudflare R2, usa el endpoint S3 oficial de la cuenta y la región `auto`. El ejecutor aprovecha el cifrado en reposo gestionado por R2 y omite el encabezado SSE de AWS. Mantén un token de objetos distinto y limitado a cada bucket.
5. Crea una cuenta de conexión operativa por instancia en PostgreSQL con una contraseña propia y sin privilegios de administración. Desde el host usa la IP privada del contenedor PostgreSQL, manteniendo el puerto fuera de Internet. Actualiza esa conexión tras recrear el contenedor si cambia la IP. Limita sus permisos a:

   ```sql
   GRANT CONNECT ON DATABASE vocero TO vocero_copias;
   GRANT USAGE ON SCHEMA public TO vocero_copias;
   GRANT SELECT ON copia_programacion TO vocero_copias;
   GRANT SELECT, INSERT, UPDATE ON copia_estado TO vocero_copias;
   ```

6. Instala las unidades [service](../scripts/copias/vocero-copias@.service) y [timer](../scripts/copias/vocero-copias@.timer) en `/etc/systemd/system/`. Ejecuta `systemctl daemon-reload`, luego `systemctl enable --now vocero-copias@UUID.timer`. Comprueba el registro con `journalctl -u vocero-copias@UUID.service`. La UI muestra que el ejecutor se conectó. Configura avisos de fallo y atraso sobre ese registro en el sistema de monitoreo del servidor y prueba la entrega.

## Copia y verificación

Desde el host, con el UUID real y fuera de un despliegue:

```bash
node /opt/vocero-copias/cli.mjs backup --instance UUID
```

Registra el ID de copia y la hora de captura. La salida se emite después de verificar la publicación. El ejecutor reanuda los escritores antes de subir los archivos. Si se interrumpe y el servicio no vuelve, ejecuta `reanudar --instance UUID` con el mismo CLI y comprueba la salud en Coolify. Si cambió el ID de los contenedores, revisa su estado en Coolify antes de reanudarlos. La descarga inicial del bucket se hace con el servicio activo. Durante la pausa se reconcilian los objetos nuevos, cambiados o eliminados por clave y ETag. Mide tres copias en staging y verifica que la captura cabe en cinco minutos antes de habilitar el horario en producción.

## Restauración

Prepara una instancia desechable con UUID distinto y `destinoPrueba: true`. Usa la revisión y clave de la copia. Mantén la base PostgreSQL 16 vacía, el volumen vacío y, si corresponde, un bucket aislado vacío. Mantén `app` y `nea` apagados y el entorno en una red Docker interna exclusiva sin puertos publicados. Deshabilita su programador. Si requiere un bucket durante el ensayo, usa un S3 de pruebas disponible dentro de la red aislada y accesible por HTTPS también desde el host, o un proxy privado que permita solo ese bucket. La UI se puede comprobar desde un navegador de pruebas conectado a esa red. Bloquea los servicios de mensajería reales y los webhooks públicos.

Para crear el destino con Docker Compose desde el checkout de la revisión, comprueba primero que el SHA de `git rev-parse HEAD` es el de la copia y prepara un archivo `.env` privado del ensayo con los valores del destino, la clave original, el UUID nuevo en `COPIAS_RESTORE_UUID` y el SHA en `COPIAS_RESTORE_SOURCE_COMMIT`. El ejemplo crea los escritores sin arrancarlos:

```bash
docker compose --env-file RUTA_ENV_PRUEBA -p vocero-restore-uuid \
  -f docker-compose.coolify.yml -f scripts/copias/restore.compose.yml create --build
docker compose --env-file RUTA_ENV_PRUEBA -p vocero-restore-uuid \
  -f docker-compose.coolify.yml -f scripts/copias/restore.compose.yml start postgres
```

```bash
node /opt/vocero-copias/cli.mjs restore --source UUID_ORIGEN --backup ID --target UUID_PRUEBA
```

Arranca solo la aplicación aislada, inicia sesión, confirma el descifrado con una credencial sintética y abre muestras de imagen, voz, video y documento. Registra los resultados y certifica la restauración solo después de completar estas verificaciones:

```bash
node /opt/vocero-copias/cli.mjs restore-verify --source UUID_ORIGEN --backup ID \
  --target UUID_PRUEBA --confirm UUID_PRUEBA
```

Una restauración interrumpida deja el destino apagado. Repite en recursos vacíos.

## Traslado y limpieza

Configura `MEDIA_STORE=bucket` junto con las variables `MEDIA_BUCKET_*` de la [guía de instalación](coolify-self-hosting.md). Comprueba la salud y abre un archivo nuevo desde Vocero. Toma y restaura una copia previa que contenga los archivos locales. Usa ese ID al trasladarlos:

```bash
node /opt/vocero-copias/cli.mjs media-migrate --instance UUID --dry-run
node /opt/vocero-copias/cli.mjs media-migrate --instance UUID --copy --backup ID
```

Resuelve los conflictos antes de seguir. Abre adjuntos históricos, un logo y el icono desde Vocero. Tras certificar la restauración de la copia y acordar la ventana, confirma el UUID exacto para eliminar los archivos locales del manifiesto:

```bash
node /opt/vocero-copias/cli.mjs media-migrate --instance UUID --prune \
  --manifest ID_MANIFIESTO --confirm UUID
```

El CLI vuelve a verificar el contenido y limita el borrado a `/data/media`. Ejecuta de nuevo el simulacro y comprueba los adjuntos con sus enlaces originales. Tras una caída del bucket, toma una nueva copia y repite el flujo para los archivos de contingencia.

Referencias: [REST API de Coolify](https://coolify.io/docs/api/endpoints/deployments/list-deployments-by-app-uuid), [pg_restore](https://www.postgresql.org/docs/16/app-pgrestore.html) y [escritura S3 condicional](https://docs.aws.amazon.com/cli/latest/reference/s3api/put-object.html).
