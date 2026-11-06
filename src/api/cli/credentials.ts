import { requestJson } from "./api-client.js";
import { flag, org, parse, positional, type Values } from "./args.js";
import { addCredential, savedLine } from "./credential-add.js";
import { print, table } from "./output.js";

const FLAGS = {
  kind: { type: "string" },
  "sign-in": { type: "string" },
  name: { type: "string" },
  "value-env": { type: "string" },
  "value-stdin": { type: "boolean", default: false },
  "token-id": { type: "string" },
  "team-id": { type: "string" },
  "project-id": { type: "string" },
  endpoint: { type: "string" },
} as const;

const basePath = (values: Values) => `/api/orgs/${encodeURIComponent(org(values))}/credentials`;

/** `credentials`; `credential add|rename|remove|complete`: the workspace's saved keys and sign-ins. */
export async function credentialCommand(args: string[], listing: boolean): Promise<void> {
  const [action, ...rest] = listing ? ["list", ...args] : args;
  const { values, positionals } = parse(rest, FLAGS);
  const base = basePath(values);
  switch (action) {
    case "list": {
      const reply = await requestJson(base);
      const credentials = reply.credentials as {
        id: string;
        name: string;
        kind: string;
        auth: string;
      }[];
      return print(values, reply, () =>
        table(credentials, [
          ["ID", (entry) => entry.id],
          ["NAME", (entry) => entry.name],
          ["KIND", (entry) => entry.kind],
          ["AUTH", (entry) => entry.auth],
        ]),
      );
    }
    case "add": {
      const saved = await addCredential(base, values);
      return print(values, saved, () => {
        savedLine(saved);
        return `Use it with --credential ${String(saved.id)}.`;
      });
    }
    case "rename": {
      const id = encodeURIComponent(positional(positionals, 0, "credential ID"));
      const name = flag(values, "name") ?? positional(positionals, 1, "NAME");
      return print(values, await requestJson(`${base}/${id}/update`, "POST", { name }));
    }
    case "remove": {
      const id = encodeURIComponent(positional(positionals, 0, "credential ID"));
      return print(values, await requestJson(`${base}/${id}/delete`, "POST"), () => "Removed.");
    }
    case "complete": {
      // A Claude sign-in started without a terminal: the code Anthropic showed after approval.
      const id = encodeURIComponent(positional(positionals, 0, "sign-in ID"));
      const code = positional(positionals, 1, "CODE");
      return print(
        values,
        await requestJson(`${base}/claude-login/${id}/complete`, "POST", { code }),
      );
    }
    default:
      throw new Error("usage: self-bench credential add|rename|remove|complete");
  }
}
