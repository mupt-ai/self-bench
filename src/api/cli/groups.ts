import { requestJson } from "./api-client.js";
import { flag, list, org, parse, positional } from "./args.js";
import { print, table } from "./output.js";

interface GroupList {
  groups: { slug: string; name: string; members?: unknown[] }[];
  repositories: { id: number; fullName: string; tasks: number }[];
}

/**
 * `groups`; `group create|show|update|delete SLUG`: repositories evaluated and released together.
 * Members are named `OWNER/NAME`; the API takes their ids, which the group list gives.
 */
export async function groupCommand(args: string[], listing: boolean): Promise<void> {
  const [action, ...rest] = listing ? ["list", ...args] : args;
  const { values, positionals } = parse(rest, {
    name: { type: "string" },
    description: { type: "string" },
    member: { type: "string", multiple: true },
  });
  const base = `/api/orgs/${encodeURIComponent(org(values))}/groups`;
  const listed = async () => (await requestJson(base)) as unknown as GroupList;
  if (action === "list") {
    const reply = await listed();
    return print(values, reply, () =>
      table(reply.groups, [
        ["GROUP", (group) => group.slug],
        ["NAME", (group) => group.name],
      ]),
    );
  }
  const slug = flag(values, "group") ?? positional(positionals, 0, "SLUG");
  const path = `${base}/${encodeURIComponent(slug)}`;
  if (action === "show") return print(values, await requestJson(path));
  if (action === "delete") return print(values, await requestJson(path, "DELETE"));
  if (action !== "create" && action !== "update")
    throw new Error("usage: self-bench group create|show|update|delete SLUG");
  const name = flag(values, "name");
  const members = list(values, "member");
  if (!name || members.length === 0)
    throw new Error(`group ${action} needs --name and --member OWNER/NAME (repeat it)`);
  const { repositories } = await listed();
  const repositoryIds = members.map((member) => {
    const found = repositories.find((repo) => repo.fullName.toLowerCase() === member.toLowerCase());
    if (!found) throw new Error(`${member} is not connected in this workspace`);
    return found.id;
  });
  const body = { name, slug, description: flag(values, "description") ?? "", repositoryIds };
  const reply = await requestJson(
    action === "create" ? base : path,
    action === "create" ? "POST" : "PUT",
    body,
  );
  print(values, reply, () => `Saved group ${slug}; pass it as --group ${slug}.`);
}
