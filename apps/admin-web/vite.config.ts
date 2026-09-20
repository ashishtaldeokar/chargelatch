import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const apiTarget = process.env.API_URL ?? "http://localhost:3000";

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { "/api": apiTarget } },
  preview: { port: 5173, proxy: { "/api": apiTarget } },
});
