import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { type Database, migrationsFolder } from "../../src/db/client.js";
import * as schema from "../../src/db/schema.js";

export interface TestDatabase {
  readonly db: Database;
  close(): Promise<void>;
}

/**
 * The site's schema over an in-process PGlite database, so the real SQL runs in tests.
 *
 * Each database holds about a hundred megabytes, and a test file keeps what it made (stores,
 * servers, fixtures) until the whole suite ends. So the stores reach the database through a
 * stand-in that lets go of it on close: a closed database's memory is then free at once, however
 * long its handles live.
 */
export async function testDatabase(): Promise<TestDatabase> {
  let client: PGlite | undefined = new PGlite();
  await client.waitReady;
  const standIn = new Proxy({} as PGlite, {
    get(_target, property) {
      if (!client) throw new Error("Test database is closed");
      const value = Reflect.get(client, property, client);
      return typeof value === "function" ? value.bind(client) : value;
    },
  });
  const db = drizzle(standIn, { schema });
  await migrate(db, { migrationsFolder: migrationsFolder() });
  return {
    db,
    close: async () => {
      const closing = client;
      client = undefined;
      await closing?.close();
      Bun.gc(true);
    },
  };
}
