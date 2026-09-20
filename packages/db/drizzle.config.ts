import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./migrations",
  // Keep drizzle-kit from trying to manage PostGIS's own tables (spatial_ref_sys, ...).
  extensionsFilters: ["postgis"],
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/chargelatch",
  },
});
