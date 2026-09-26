CREATE TYPE "public"."transaction_state" AS ENUM('starting', 'active', 'stopping', 'stopped', 'failed');--> statement-breakpoint
CREATE TYPE "public"."webhook_delivery_status" AS ENUM('pending', 'delivered', 'failed');--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"keycloak_client_id" text NOT NULL,
	"webhook_url" text,
	"meter_value_interval_seconds" integer DEFAULT 30 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenants_keycloak_client_id_unique" UNIQUE("keycloak_client_id")
);
--> statement-breakpoint
CREATE TABLE "transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"transaction_id" text NOT NULL,
	"device_id" integer NOT NULL,
	"state" "transaction_state" DEFAULT 'starting' NOT NULL,
	"meter_value_interval_seconds" integer NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"stop_requested_at" timestamp with time zone,
	"stopped_at" timestamp with time zone,
	"stop_reason" text,
	"meter_start_kwh" double precision,
	"meter_stop_kwh" double precision,
	"energy_wh" real,
	"energy_quality" text,
	"power_avg_w" real,
	"power_max_w" real,
	"current_max_a" real,
	"voltage_min_v" real,
	"voltage_max_v" real,
	"sample_count" integer,
	"meter_unreadable_samples" integer,
	"failure_reason" text
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"transaction_id" uuid,
	"event_type" text NOT NULL,
	"sequence" integer NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "webhook_delivery_status" DEFAULT 'pending' NOT NULL,
	"retry" boolean DEFAULT true NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"last_status_code" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "tenant_id" text;--> statement-breakpoint
ALTER TABLE "meter_readings" ADD COLUMN "transaction_id" uuid;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "transactions_tenant_tx_idx" ON "transactions" USING btree ("tenant_id","transaction_id");--> statement-breakpoint
CREATE INDEX "transactions_device_idx" ON "transactions" USING btree ("device_id","requested_at");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_pending_idx" ON "webhook_deliveries" USING btree ("tenant_id","status","next_attempt_at");