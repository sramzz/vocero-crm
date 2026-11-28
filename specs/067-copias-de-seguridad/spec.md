# Especificación 067 — Copias de seguridad y traslado de medios

- **Horario.** Coolify administra una tarea PostgreSQL cada ocho horas (tres veces al día), con ejecución manual e historial en el mismo lugar. Vocero puede seguir atendiendo durante el dump. El cambio de horario se guarda en Coolify.
- **Destino.** Una copia consistente de la base completa, incluidos los esquemas de Vocero y Nea, se verifica y publica en el bucket privado de copias. La instancia usa credenciales distintas para ese bucket y el de medios. La configuración es opcional para cada instancia.
- **Medios.** Los archivos nuevos se guardan en el bucket de medios. En una ventana de mantenimiento se inventarían y copian los archivos del volumen con sus claves originales y sin sobrescribir objetos distintos. La protección independiente de medios incluye el bucket y los archivos de contingencia del volumen. Tras verificar la recuperación y los enlaces originales, el operador puede autorizar la limpieza. El volumen sigue disponible para contingencias.
- **Recuperación.** Una copia de base se acepta al verificar el manifiesto y restaurarla en PostgreSQL 16 desechable. Verificar una conversación de prueba y sus adjuntos desde Vocero aislado. El dump contiene metadatos de archivos. Los binarios se recuperan del bucket de medios o su copia independiente. Custodiar fuera de R2 la clave de cifrado y los secretos para reconstruir la instancia.

## Criterios de aceptación

1. La tarea usa el contenedor `app` que ya despliega Coolify. El flujo regular funciona sin SSH, `systemd`, acceso al socket de Docker ni otro contenedor permanente.
2. La tarea de Coolify puede ejecutar `pg_dump -Fc`, comprobarlo y publicarlo en R2. El manifiesto aparece solo tras verificar la huella del archivo remoto. Un fallo no invalida las copias anteriores.
3. El operador puede probar una restauración aislada de base y medios. La limpieza local exige la confirmación del operador y comprueba que los archivos siguen en el bucket y en la copia recuperada.
4. La actualización conserva el Compose, los volúmenes, la conexión de medios y las migraciones desplegadas. La pantalla de horarios de Vocero se retira.
