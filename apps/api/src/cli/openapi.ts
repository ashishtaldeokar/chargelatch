// Prints the OpenAPI document without starting a server or touching the database, e.g. for
// client generation: `pnpm --filter @chargelatch/api run openapi > openapi.json`
import { createApp, openApiInfo } from "../app.ts";

const unused = () => Promise.reject(new Error("not available while generating the spec"));
const app = createApp({
  users: { list: unused, create: unused },
  devices: { register: unused, get: unused, getByIdentity: unused, list: unused, markFlashed: unused },
  bus: { getState: () => { throw new Error("unused"); }, setRelay: unused },
  telemetry: { recentPower: unused },
  auth: { verify: unused },
});

console.log(JSON.stringify(app.getOpenAPI31Document(openApiInfo), null, 2));
