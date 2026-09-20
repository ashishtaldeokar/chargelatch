import { startEnvironment } from "./environment.ts";

// Containers are started here (under Bun) and their URLs are passed down to
// Playwright, which boots the API + web servers via `webServer` in its config.
console.log("starting containers…");
const environment = await startEnvironment();

let exitCode = 1;
try {
  const playwright = Bun.spawn(["playwright", "test", ...process.argv.slice(2)], {
    env: { ...process.env, ...environment.env },
    stdio: ["inherit", "inherit", "inherit"],
  });
  exitCode = await playwright.exited;
} finally {
  await environment.stop();
}
process.exit(exitCode);
