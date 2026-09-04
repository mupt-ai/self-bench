import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { projectRoot } from "../project-paths.js";
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

/** Opens the site database and applies any migration it has not seen. */
export async function openDatabase(url: string): Promise<OpenDatabase> {
  const client = postgres(url, { max: 8, onnotice: () => undefined });
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: migrationsFolder() });
  return { db, close: () => client.end({ timeout: 5 }) };
}
