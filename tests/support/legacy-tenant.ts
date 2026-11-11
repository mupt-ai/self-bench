import type { PGlite } from "@electric-sql/pglite";

/**
 * A user with a personal tenant, written in the schema migrations before 0039 left: there the
 * tenant carries its GitHub id itself. Migration tests that stop early seed with this, since the
 * user store writes today's schema.
 */
export async function legacyTenant(
  client: PGlite,
  login: string,
): Promise<{ user: { id: number }; org: { id: number } }> {
  const user = await client.query<{ id: number }>(
    "INSERT INTO users (github_id, login, github_token) VALUES (1, $1, 'sealed') RETURNING id",
    [login],
  );
  const org = await client.query<{ id: number }>(
    "INSERT INTO orgs (github_id, login, kind) VALUES (1, $1, 'user') RETURNING id",
    [login],
  );
  const [userRow, orgRow] = [user.rows[0], org.rows[0]];
  if (!userRow || !orgRow) throw new Error("legacy tenant insert returned no row");
  await client.query("INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, 'admin')", [
    orgRow.id,
    userRow.id,
  ]);
  return { user: { id: Number(userRow.id) }, org: { id: Number(orgRow.id) } };
}
