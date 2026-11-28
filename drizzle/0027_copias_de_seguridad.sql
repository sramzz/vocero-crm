CREATE TABLE "copia_estado" (
	"organization_id" text NOT NULL,
	"instancia_id" text NOT NULL,
	"contacto" timestamp NOT NULL,
	"turno" timestamp,
	"ultima_captura" timestamp,
	"ultima_verificada" timestamp,
	"resultado" text,
	"aviso_desde" timestamp
);
--> statement-breakpoint
CREATE TABLE "copia_programacion" (
	"organization_id" text NOT NULL,
	"instancia_id" text NOT NULL,
	"habilitada" boolean DEFAULT false NOT NULL,
	"frecuencia" text DEFAULT '8h' NOT NULL,
	"hora_utc" text DEFAULT '08:00' NOT NULL,
	"dia" integer,
	"desde" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "copia_estado" ADD CONSTRAINT "copia_estado_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copia_programacion" ADD CONSTRAINT "copia_programacion_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "copia_estado_org_instancia_idx" ON "copia_estado" USING btree ("organization_id","instancia_id");--> statement-breakpoint
CREATE UNIQUE INDEX "copia_programacion_org_instancia_idx" ON "copia_programacion" USING btree ("organization_id","instancia_id");