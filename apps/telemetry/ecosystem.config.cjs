// PM2 process file for the telemetry ingest service. Same conventions as apps/api/ecosystem.config.cjs:
// config from apps/telemetry/.env (DATABASE_URL, MQTT_URL), the workspace's pinned Bun, ONE instance
// (two would store every reading twice; the MQTT client id is per process).
//
//   pnpm db:migrate                       # the hypertables come from packages/db migrations
//   pm2 start apps/telemetry/ecosystem.config.cjs
const { existsSync } = require("node:fs");
const { join } = require("node:path");

const workspaceBun = join(__dirname, "../../node_modules/bun/bun");

module.exports = {
  apps: [
    {
      name: "chargelatch-telemetry",
      cwd: __dirname,
      script: "src/index.ts",
      interpreter: existsSync(workspaceBun) ? workspaceBun : "bun",
      exec_mode: "fork",
      instances: 1,
      env: { NODE_ENV: "production" },
      autorestart: true,
      exp_backoff_restart_delay: 200,
      max_restarts: 20,
      min_uptime: "10s",
      max_memory_restart: "512M",
      // Enough for the final batch flush in the SIGINT handler.
      kill_timeout: 8000,
      time: true,
      merge_logs: true,
    },
  ],
};
