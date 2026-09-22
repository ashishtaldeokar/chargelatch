CREATE TYPE "public"."device_event_kind" AS ENUM('online', 'offline', 'relay_on', 'relay_off');--> statement-breakpoint
CREATE TABLE "device_events" (
	"time" timestamp with time zone NOT NULL,
	"device_id" integer NOT NULL,
	"kind" "device_event_kind" NOT NULL,
	"detail" text
);
--> statement-breakpoint
CREATE TABLE "meter_readings" (
	"time" timestamp with time zone NOT NULL,
	"device_id" integer NOT NULL,
	"model" text NOT NULL,
	"ok" boolean NOT NULL,
	"error" text,
	"voltage" real,
	"current" real,
	"power" real,
	"apparent_power" real,
	"reactive_power" real,
	"power_factor" real,
	"phase_angle" real,
	"frequency" real,
	"import_energy" double precision,
	"export_energy" double precision,
	"total_energy" double precision,
	"import_reactive_energy" double precision,
	"export_reactive_energy" double precision,
	"total_reactive_energy" double precision,
	"voltage_l1" real,
	"voltage_l2" real,
	"voltage_l3" real,
	"current_l1" real,
	"current_l2" real,
	"current_l3" real,
	"power_l1" real,
	"power_l2" real,
	"power_l3" real,
	"power_factor_l1" real,
	"power_factor_l2" real,
	"power_factor_l3" real,
	"extra" jsonb
);
--> statement-breakpoint
CREATE TABLE "meter_readings_15m" (
	"bucket" timestamp with time zone NOT NULL,
	"device_id" integer NOT NULL,
	"samples" integer NOT NULL,
	"failed_samples" integer NOT NULL,
	"power_avg" real,
	"power_min" real,
	"power_max" real,
	"voltage_avg" real,
	"voltage_min" real,
	"voltage_max" real,
	"current_avg" real,
	"current_min" real,
	"current_max" real,
	"power_factor_avg" real,
	"frequency_avg" real,
	"energy_wh" real,
	"total_energy_end" double precision
);
