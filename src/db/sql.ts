import postgres from "postgres";

/**
 * The narrow slice of a Postgres client the site uses. Production binds it to the
 * `postgres` driver; tests bind the same interface to PGlite so the SQL runs for real.
 */
export interface SqlClient {
  /** Runs one parameterized statement (`$1`, `$2`, …) and returns its rows. */
  query<Row = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<Row[]>;
  /** Runs a multi-statement script without parameters (migrations). */
  exec(text: string): Promise<void>;
  /** Runs `work` inside one transaction on a single connection. */
  transaction<T>(work: (tx: SqlClient) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export function postgresClient(url: string): SqlClient {
  const sql = postgres(url, { max: 8, onnotice: () => undefined });
  return wrap(sql, () => sql.end({ timeout: 5 }));
}

type Executor = Pick<ReturnType<typeof postgres>, "unsafe" | "begin">;

function wrap(sql: Executor, close: () => Promise<void>): SqlClient {
  return {
    async query<Row>(text: string, params: readonly unknown[] = []): Promise<Row[]> {
      const rows = await sql.unsafe(text, [...params] as never[]);
      return [...rows] as Row[];
    },
    async exec(text: string): Promise<void> {
      await sql.unsafe(text);
    },
    transaction: <T>(work: (tx: SqlClient) => Promise<T>): Promise<T> =>
      sql.begin((tx) => work(wrap(tx as unknown as Executor, async () => undefined))) as Promise<T>,
    close,
  };
}
