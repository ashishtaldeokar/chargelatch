import type { Hook, z } from "@hono/zod-openapi";

export const openApiInfo = {
  openapi: "3.1.0",
  info: { title: "chargelatch API", version: "0.0.0" },
} as const;

export const json = <T extends z.ZodType>(schema: T, description: string) => ({
  content: { "application/json": { schema } },
  description,
});

/** Runs for every validated route: turns zod failures into the documented Error shape. */
export const defaultHook: Hook<any, any, any, any> = (result, c) => {
  if (result.success) return;
  return c.json(
    {
      error: "Invalid request",
      issues: result.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
    },
    400,
  );
};
