# Instalar este fork en Coolify 4.6 sin MCP ni API

Revisado el 6 de noviembre de 2026, contra el commit de origen
`b29900d34668533d7f22ee7ebb8c3eb099c36bef`.

Carril exento: receta de despliegue y documentación; sin cambios al producto,
al modelo de datos ni a contratos. Supuesto: instalación nueva en un servidor
Coolify existente, con su proxy integrado activo. No reutilizar esta receta
para migrar datos de otra instancia sin planificar la restauración.

## Decisión y fuentes

Recomendación: desplegar desde Git con `docker-compose.coolify.yml`. Construye
el CRM desde el fork y mantiene PostgreSQL y Nea en la red privada. Coolify
gestiona el dominio y HTTPS. La receta original agrega Caddy en los puertos
80/443; no usarla directamente en este servidor.

Hechos verificados:

- [Compose de origen](../docker-compose.yml): PostgreSQL 16, Nea 2.0.2 y
  persistencia en `/data` y `/var/lib/postgresql/data`.
- [Dockerfile](../Dockerfile): puerto 3000, migraciones automáticas al arrancar,
  prueba de salud `/api/health` y secretos solo en runtime.
- [Entorno](../src/lib/env.ts): formato de secretos y variables obligatorias.
- [Registro](../src/server/auth/registration.ts): se cierra después de crear
  la primera organización, salvo `ALLOW_SIGNUP=true`.
- [Coolify: repositorios públicos](https://coolify.io/docs/applications/sources/public-repositories):
  acceso sin autenticación; el despliegue manual no necesita webhook.
- [Coolify: Compose](https://coolify.io/docs/applications/builds/docker-compose):
  ruta del archivo, servicios, variables y volúmenes.
- [Coolify: dominios](https://coolify.io/docs/core/networking/domains):
  DNS, proxy y puerto interno del servicio.
- [Coolify: variables](https://coolify.io/docs/applications/configuration/environment-variables):
  configuración de runtime y build.

## 1. Publicar la receta en el fork

Estos archivos están inicialmente solo en el workspace local. Coolify no los
verá hasta que se suban a GitHub. Desde la raíz del proyecto:

```bash
git add docker-compose.coolify.yml docs/coolify-self-hosting.md
git commit -m "chore: preparar despliegue en Coolify"
git push vocero HEAD:main
```

El remote `vocero` apunta a `https://github.com/sramzz/vocero-crm.git`.
El remote `origin` preexistente se conservó y apunta a `self-vocero.git`:
no usar `git push` sin indicar el remote para este paso.

## 2. Preparar dominio y servidor

1. Crear un registro DNS A para `crm.example.com` hacia la IP pública del
   servidor donde correrá la aplicación. Sustituir ese dominio en toda la guía.
2. Confirmar que los puertos TCP 80/443 llegan al proxy de Coolify. Si hay un
   registro AAAA, también debe llegar al servidor correcto.
3. Verificar que el servidor esté conectado y validado en Coolify.

La [guía de origen](../README.md#requisitos) cita 2 GB para ejecutar la imagen
publicada, no para compilar. Esta receta compila Next.js; como recomendación
operativa, reservar al menos 4 GB libres o usar un servidor de build separado.
El CRM se construye para la arquitectura del servidor. La imagen publicada de
Nea se hereda de la receta original: verificar su compatibilidad si el VPS es ARM.

## 3. Crear el recurso

1. Abrir proyecto → entorno de producción → **+ New → Public Repository**.
2. Pegar `https://github.com/sramzz/vocero-crm` → **Check Repository**.
3. Seleccionar servidor/destino y rama `main`.
4. En **General → Build pipeline**, elegir **Compose** en **Build strategy**.
5. Poner **Base Directory** = `/` y **Docker Compose Location** =
   `/docker-compose.coolify.yml`.
6. Guardar y recargar la configuración. Confirmar los servicios `app`, `nea`
   y `postgres`. Mantener el modo administrado por Coolify; no usar Raw Compose.

## 4. Generar secretos e introducir variables

En una terminal privada propia, ejecutar los comandos siguientes por separado.
Cada resultado corresponde a la variable del comentario. Guardarlos en un gestor
de contraseñas; no pegarlos en este chat ni en GitHub.

```bash
# POSTGRES_PASSWORD: hexadecimal, seguro dentro de DATABASE_URL sin escapado.
openssl rand -hex 32
# BETTER_AUTH_SECRET
openssl rand -hex 32
# ENCRYPTION_KEY: exactamente 32 bytes codificados en base64.
openssl rand -base64 32
# META_WEBHOOK_VERIFY_TOKEN
openssl rand -hex 32
# BOT_API_KEY: secreto compartido entre CRM y Nea; no es una API key de Coolify.
openssl rand -hex 32
```

En **Environment Variables**, asignar:

```dotenv
APP_BASE_URL=https://crm.example.com
POSTGRES_PASSWORD=PEGAR_RESULTADO_1
BETTER_AUTH_SECRET=PEGAR_RESULTADO_2
ENCRYPTION_KEY=PEGAR_RESULTADO_3
META_WEBHOOK_VERIFY_TOKEN=PEGAR_RESULTADO_4
BOT_API_KEY=PEGAR_RESULTADO_5
```

Para estas variables: **Runtime** disponible, **Build time** no disponible.
Usar valores reales, no los marcadores. La aplicación no necesita secretos para
compilar. Si se usa Developer view, conservar las otras entradas existentes:
guardar esa vista reemplaza la lista de variables.

No definir `DATABASE_URL` por separado: la receta la construye con el nombre
interno `postgres`. No activar `ALLOW_SIGNUP`. Dejar las variables opcionales
de IA, Meta y banderas vacías hasta necesitarlas.

Conservar `ENCRYPTION_KEY`: cambiarla sin migración impide descifrar las
credenciales guardadas. Cambiar `POSTGRES_PASSWORD` en el panel después de
inicializar el volumen no cambia la contraseña ya guardada en PostgreSQL.

## 5. Dominio y persistencia

En **Domains → Add domain**:

- Servicio: `app`.
- Protocolo: `https`.
- Dominio: `crm.example.com`.
- Puerto interno: `3000`.

Si la interfaz muestra un solo campo, usar `https://crm.example.com:3000`.
Los visitantes abren `https://crm.example.com`, sin `:3000`.
No asignar dominios ni puertos públicos a PostgreSQL o Nea.

Los volúmenes están declarados en Compose: `vocero_pg` conserva PostgreSQL y
`vocero_app_data` conserva adjuntos, logo e icono bajo `/data`. No agregar
montajes duplicados en el panel, ni forzar otro usuario del contenedor.

## 6. Desplegar y comprobar

1. Pulsar **Deploy**. Revisar **Deployment Logs**; la primera compilación
   puede tardar varios minutos.
2. Revisar **Runtime Logs** de los tres servicios. El CRM aplica migraciones
   automáticamente antes de iniciar el servidor; no ejecutar otra migración
   manual en paralelo.
3. Abrir `https://crm.example.com/api/health`. Debe responder HTTP 200, con
   `"ok":true`, `"version":"2.7.0"` y `"mediaWritable":true`.
4. Abrir `https://crm.example.com/register` y crear el primer propietario y
   organización enseguida. Después se cierra el registro público automáticamente.
5. Subir un logo, volver a desplegar y confirmar que se conserva: comprueba
   el volumen, además de la salud de la base de datos.

Sin proveedor de IA configurado, usar la bandeja manual. El contenedor Nea
está incluido, pero dejar apagado el interruptor del Agente hasta configurar
el proveedor y comprobar su salud desde Vocero.

## 7. Conectar WhatsApp y, opcionalmente, IA

Seguir la [conexión de WhatsApp del proyecto](../README.md#conexión-del-número-de-whatsapp).
En **Configuración → WhatsApp**, introducir WABA ID, Phone Number ID y el
token de Meta; probar y guardar. Si pide configuración manual del webhook,
copiar de Vocero la URL y el verify token exactos al panel de Meta y suscribir
`messages`. Configurar `META_APP_SECRET` en Coolify y volver a desplegar para
activar la validación de firma de los eventos. No confundir ese secreto con
`META_WEBHOOK_VERIFY_TOKEN`.

Para IA, usar **Ajustes → IA** y elegir proveedor, credencial y modelo.
Nea usa el proxy del CRM; no necesita recibir directamente la credencial del
proveedor. Configurar el perfil/conocimiento y comprobar la conexión antes de
encender el Agente. Mientras se prueba, restringir `ALLOWED_WA_IDS` al número
de prueba propio, tal como describe el [Compose de origen](../docker-compose.yml).

## 8. Copias, actualizaciones y diagnóstico

- Respaldar PostgreSQL mediante una copia lógica y también los archivos de
  `/data`; guardar los secretos aparte. No basta respaldar solo Coolify.
  Antes de actualizar, comprobar que se puede restaurar la copia.
- Para actualizar el fork: subir los cambios a GitHub y pulsar **Deploy**.
  El webhook de GitHub es opcional y se puede configurar después. No se
  necesita una API key de Coolify para desplegar manualmente.
- Error de puertos 80/443: confirmar que se eligió la receta de Coolify,
  no `docker-compose.yml` con Caddy.
- Error 502: comprobar `app`, puerto interno 3000 y logs de migración.
- Salud 503: revisar variables obligatorias, base de datos y su contraseña.
- `mediaWritable:false`: revisar montaje `/data` y logs del entrypoint.
- Compilación terminada por falta de memoria: aumentar recursos o separar
  el servidor de build.
- HTTPS sin certificado: revisar A/AAAA y acceso al proxy en 80/443.

## Verificación de esta entrega

La receta se valida estáticamente con `docker compose config`, usando valores
de prueba en memoria, sin generar ni guardar secretos reales. El despliegue
real en Coolify, HTTPS, persistencia y conexión de WhatsApp quedan pendientes
de verificación humana en el servidor del usuario. Esta guía no afirma que
la aplicación ya esté desplegada.
