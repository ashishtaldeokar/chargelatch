// PM2 process file for the API.  (.cjs because this package is "type": "module" and PM2 loads
// its config with require().)
//
//   pnpm install --frozen-lockfile        # from the repo root; also fetches the pinned Bun
//   pnpm db:migrate                       # apply pending migrations BEFORE (re)starting
//   pm2 start apps/api/ecosystem.config.cjs
//   pm2 reload chargelatch-api            # after a deploy
//   pm2 logs chargelatch-api
//   pm2 save && pm2 startup               # once, to come back after a reboot
//
// Configuration is NOT in this file: Bun loads apps/api/.env from `cwd` by itself. That file must
// define DATABASE_URL, KEYCLOAK_ISSUER and MQTT_URL (see .env.example). Variables already present
// in PM2's environment win over .env, so keep secrets out of `env` below.
const { existsSync } = require("node:fs");
const { join } = require("node:path");

// The Bun that pnpm installs for this workspace (devEngines.runtime in the root package.json), so
// production runs the version the lockfile pins. Falls back to a `bun` on PATH.
const workspaceBun = join(__dirname, "../../node_modules/bun/bun");

module.exports = {
  apps: [
    {
      name: "chargelatch-api",
      cwd: __dirname,
      script: "src/index.ts",
      interpreter: existsSync(workspaceBun) ? workspaceBun : "bun",

      // Exactly ONE process, in fork mode. Live device state (online, relay, meter) and the
      // in-flight relay confirmations live in this process's memory (src/device-bus.ts); a second
      // instance would answer from its own, different state. PM2's cluster mode is also
      // Node-only and does not work with Bun.
      exec_mode: "fork",
      instances: 1,

      env: {
        NODE_ENV: "production",
        PORT: process.env.PORT || 3000,
      },

      autorestart: true,
      // Crash loops (database or broker down at boot) back off instead of spinning.
      exp_backoff_restart_delay: 200,
      max_restarts: 20,
      min_uptime: "10s",
      max_memory_restart: "512M",
      // Let in-flight relay commands (up to 5 s, waiting for the device) finish on reload.
      kill_timeout: 8000,

      time: true,
      merge_logs: true,
    },
  ],
};
