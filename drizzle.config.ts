import { defineConfig } from "drizzle-kit";

/** `bunx drizzle-kit generate` writes SQL migrations for schema changes into ./drizzle. */
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  strict: true,
  verbose: true,
});
