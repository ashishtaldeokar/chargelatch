import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const apiTarget = process.env.API_URL ?? "http://localhost:3000";

// Port 5174 is registered as the redirect URI of the `chargelatch-factory` Keycloak client, and
// Web Serial needs a secure context (localhost counts), so the port is strict.
export default defineConfig({
  plugins: [react()],
  server: { port: 5174, strictPort: true, proxy: { "/api": apiTarget } },
  preview: { port: 5174, strictPort: true, proxy: { "/api": apiTarget } },
});
