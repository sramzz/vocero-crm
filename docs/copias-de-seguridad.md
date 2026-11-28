# Copias de seguridad con Coolify

El horario se edita en **Coolify → aplicación → Scheduled Tasks**. La tarea corre en el contenedor `app` existente. El dump de PostgreSQL se hace con Vocero y Nea funcionando. El bucket de medios y el de copias requieren tokens de objetos distintos y limitados a su bucket.

## Programar PostgreSQL

1. Instala la revisión que incluye el target `coolify` de `docker-compose.coolify.yml`. Añade las variables de ejecución `COPIAS_BUCKET_ENDPOINT`, `COPIAS_BUCKET_NAME`, `COPIAS_BUCKET_REGION`, `COPIAS_BUCKET_KEY_ID` y `COPIAS_BUCKET_SECRET`. Para R2 usa el endpoint S3 de cuenta y región `auto`. Guarda los secretos en Coolify.
2. Crea una tarea en la aplicación. Elige el contenedor `app`, frecuencia `0 */8 * * *` y un plazo compatible con el tamaño de la base. Ajusta la zona horaria del calendario en el servidor o toma su zona en cuenta. Ejecuta:

   ```sh
   su-exec vocero flock -n /data/.vocero-copias.lock node /app/copias/ejecutar.mjs postgres
   ```

3. Prueba **Execute now**. El resultado muestra un ID y una huella. Verifica `postgres/ID/vocero.dump` y `postgres/ID/manifiesto.json` en R2. Un conjunto se considera publicado cuando ya aparece el manifiesto. Configura reglas de ciclo de vida de 30 días para el prefijo `postgres/` y para las cargas multipart incompletas según tu política. Supervisa el historial de Coolify y conserva una copia verificada adicional si hay una incidencia prolongada.

## Restaurar PostgreSQL

Descarga el dump y su manifiesto por HTTPS con un token autorizado. Comprueba el origen, la revisión, el tamaño y SHA-256. Comprueba también la huella de los 32 bytes decodificados de la clave de cifrado que conservas fuera de R2. Prepara PostgreSQL 16 con una base nueva y vacía, un volumen nuevo y un bucket de medios de prueba. Puede ser un Compose desechable en tu equipo o una instancia separada de Coolify con un UUID distinto. Deshabilita mensajería y webhooks reales antes de arrancar Vocero. Restaura en una transacción:

```sh
pg_restore --exit-on-error --single-transaction --no-owner --no-acl --dbname=BASE_DE_PRUEBA vocero.dump
```

Para recuperar los binarios, descarga `medios/ID/medios.tar.gz` y su manifiesto con el mismo procedimiento. Comprueba ambos archivos y extrae el tar en un directorio desechable. Copia el contenido de `bucket/` al bucket de prueba conservando las claves y el de `local/` al directorio de medios del volumen de prueba. Conserva la `ENCRYPTION_KEY` original y los demás secretos fuera del bucket. Arranca la revisión del manifiesto contra el destino aislado con esa clave. Inicia sesión, comprueba datos y descifrado, y vuelve a abrir los enlaces de adjuntos originales usando el dominio del destino. Registra los dos IDs de copia y el resultado.

## Proteger y trasladar medios

La tarea de PostgreSQL guarda referencias. La operación `medios-proteger` copia el bucket de medios y el directorio local en un archivo aparte dentro del prefijo `medios/`. Ejecuta los comandos desde el terminal del contenedor `app` en Coolify, sustituyendo el argumento:

```sh
su-exec vocero flock -n /data/.vocero-copias.lock node /app/copias/ejecutar.mjs medios-inventario
su-exec vocero flock -n /data/.vocero-copias.lock node /app/copias/ejecutar.mjs medios-proteger
su-exec vocero flock -n /data/.vocero-copias.lock node /app/copias/ejecutar.mjs medios-copiar
```

Pon la instancia en una ventana sin nuevos cambios de medios antes de proteger y trasladar. Configura el modo bucket, restringe el ingreso y espera que terminen los trabajos pendientes. Mantén el contenedor de operaciones disponible. Verifica la huella de `medios.tar.gz`, extrae el archivo en un directorio desechable y abre muestras de `bucket/` y `local/`. Comprueba en Vocero que los adjuntos originales funcionan. Con ese ID verificado, autoriza la limpieza:

```sh
su-exec vocero flock -n /data/.vocero-copias.lock node /app/copias/ejecutar.mjs medios-limpiar ID --confirm ID
```

El comando verifica el archivo protegido y los bytes remotos antes de limpiar. Conserva el volumen para archivos de contingencia. Repite el inventario y abre otra vez los adjuntos al terminar. Programa la protección de medios por separado si corresponde y revisa el espacio temporal necesario.
