import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { projectRoot } from "../lib/project-paths.js";
import * as schema from "./schema.js";

/** Any Drizzle Postgres database over our schema: postgres-js in production, PGlite in tests. */
export type Database = PgDatabase<PgQueryResultHKT, typeof schema>;

export interface OpenDatabase {
  readonly db: Database;
  close(): Promise<void>;
}

export function migrationsFolder(): string {
  return `${projectRoot(import.meta.url)}/drizzle`;
}

/**
 * Opens the site database and applies any migration it has not seen. A `light` client (the
 * Harbor workers, which may run by the dozen) keeps at most two connections, closes them when
 * idle, and leaves migrations to the API.
 */
export async function openDatabase(
  url: string,
  { light = false }: { light?: boolean } = {},
): Promise<OpenDatabase> {
  const client = postgres(url, {
    max: light ? 2 : 8,
    ...(light ? { idle_timeout: 30 } : {}),
    onnotice: () => undefined,
  });
  const db = drizzle(client, { schema });
  if (!light) await migrate(db, { migrationsFolder: migrationsFolder() });
  return { db, close: () => client.end({ timeout: 5 }) };
}
