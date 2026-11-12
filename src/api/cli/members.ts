import { requestJson } from "./api-client.js";
import { flag, org, parse, positional, type Values } from "./args.js";
import { print, table } from "./output.js";

const base = (values: Values) => `/api/orgs/${encodeURIComponent(org(values))}`;
const role = (value: string | undefined) => {
  if (value !== undefined && value !== "admin" && value !== "member")
    throw new Error("--role must be admin or member");
  return value;
};

interface Member {
  login: string;
  role: string;
  source: string;
}

/** `members`: the workspace's people, and the GitHub organizations it brings them from. */
export async function membersCommand(args: string[]): Promise<void> {
  const { values } = parse(args);
  const reply = await requestJson(`${base(values)}/members`);
  const github = reply.github as { login: string }[];
  print(values, reply, () =>
    [
      table(reply.members as Member[], [
        ["MEMBER", (member) => member.login],
        ["ROLE", (member) => member.role],
        ["THROUGH", (member) => (member.source === "github" ? "GitHub" : "invite")],
      ]),
      github.length ? `GitHub: ${github.map((account) => account.login).join(", ")}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
  );
}

/** `member invite|role|remove LOGIN`, `member invites`, `member revoke ID` (admins). */
export async function memberCommand(args: string[]): Promise<void> {
  const [action, ...rest] = args;
  const { values, positionals } = parse(rest, { role: { type: "string" } });
  const path = base(values);
  if (action === "invites") {
    const reply = await requestJson(`${path}/invites`);
    return print(values, reply, () =>
      table(reply.invites as { id: number; githubLogin: string; role: string }[], [
        ["ID", (invite) => invite.id],
        ["LOGIN", (invite) => invite.githubLogin],
        ["ROLE", (invite) => invite.role],
      ]),
    );
  }
  if (action === "revoke") {
    const id = positional(positionals, 0, "ID");
    return print(
      values,
      await requestJson(`${path}/invites/${encodeURIComponent(id)}/delete`, "POST", {}),
    );
  }
  const login = encodeURIComponent(positional(positionals, 0, "LOGIN"));
  if (action === "invite")
    return print(
      values,
      await requestJson(`${path}/invites`, "POST", {
        login: positionals[0],
        role: role(flag(values, "role")) ?? "member",
      }),
    );
  if (action === "role") {
    const chosen = role(flag(values, "role") ?? positional(positionals, 1, "ROLE"));
    return print(
      values,
      await requestJson(`${path}/members/${login}/role`, "POST", { role: chosen }),
    );
  }
  if (action === "remove")
    return print(values, await requestJson(`${path}/members/${login}/delete`, "POST", {}));
  throw new Error(
    "usage: self-bench member invite LOGIN [--role admin|member] | role LOGIN admin|member | remove LOGIN | invites | revoke ID",
  );
}

/** `workspace create NAME [--name TEXT]`, `workspace connect GITHUB_ORG`, `workspace rename TEXT`. */
export async function workspaceCommand(args: string[]): Promise<void> {
  const [action, ...rest] = args;
  const { values, positionals } = parse(rest, { name: { type: "string" } });
  if (action === "create") {
    const name = flag(values, "name");
    return print(
      values,
      await requestJson("/api/orgs", "POST", {
        login: positional(positionals, 0, "NAME"),
        ...(name ? { name } : {}),
      }),
    );
  }
  if (action === "connect")
    return print(
      values,
      await requestJson(`${base(values)}/github`, "POST", {
        login: positional(positionals, 0, "GITHUB_ORG"),
      }),
    );
  if (action === "rename")
    return print(
      values,
      await requestJson(`${base(values)}/settings`, "POST", {
        name: positionals.join(" ") || null,
      }),
    );
  throw new Error(
    "usage: self-bench workspace create NAME [--name TEXT] | connect GITHUB_ORG | rename TEXT",
  );
}
