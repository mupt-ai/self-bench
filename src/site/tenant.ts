import type { Org, User, UserStore } from "../auth/users.js";

/** The tenant a signed-in user asked for, if they belong to it (login compared case-insensitively). */
export async function tenantFor(
  users: UserStore,
  user: User,
  login: string,
): Promise<Org | undefined> {
  const wanted = login.toLowerCase();
  return (await users.orgsFor(user.id)).find((org) => org.login.toLowerCase() === wanted);
}
