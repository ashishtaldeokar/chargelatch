CREATE TABLE "devices" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "devices_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"identity" text GENERATED ALWAYS AS ('SONIK-' || id::text) STORED NOT NULL,
	"mac_address" "macaddr" NOT NULL,
	"chip_type" text NOT NULL,
	"chip_revision" text,
	"chip_features" text[] DEFAULT '{}' NOT NULL,
	"crystal_mhz" integer,
	"flash_size_bytes" integer,
	"firmware_version" text,
	"flash_count" integer DEFAULT 0 NOT NULL,
	"last_flashed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "devices_identity_unique" UNIQUE("identity"),
	CONSTRAINT "devices_mac_address_unique" UNIQUE("mac_address")
);
