import { requestJson } from "./api-client.js";
import { flag, list, org, parse, positional, scopePath, type Values } from "./args.js";
import { print, table } from "./output.js";

interface PreviewSetting {
  key: string;
  label: string;
  harness: string;
  reasoningLevel: string;
  coverage: number[];
  ticked: boolean;
}

interface ReleaseView {
  preview: { fingerprint: string; tasks: unknown[]; unrun: number; settings: PreviewSetting[] };
  head: { id: string } | null;
}

interface Release {
  id: string;
  releasedAt: string;
  releasedBy: string;
  tasks: number;
  settings: number;
  current: boolean;
  withdrawnAt?: string;
}

const releaseTable = (releases: Release[]) =>
  table(releases, [
    ["RELEASE", (release) => release.id],
    ["RELEASED", (release) => release.releasedAt],
    ["BY", (release) => release.releasedBy],
    ["TASKS", (release) => release.tasks],
    ["SETTINGS", (release) => release.settings],
    ["STATE", (release) => (release.withdrawnAt ? "withdrawn" : release.current ? "current" : "")],
  ]);

/**
 * `releases`; `release preview|publish|withdraw`: a public repository's (or group's) results on
 * selfbench.dev. Publishing releases the preview it just read, so it never publishes unseen results.
 */
export async function releaseCommand(args: string[], listing: boolean): Promise<void> {
  const [action, ...rest] = listing ? ["list", ...args] : args;
  const { values, positionals } = parse(rest, {
    setting: { type: "string", multiple: true },
    "all-settings": { type: "boolean", default: false },
    "publish-tasks": { type: "boolean", default: false },
    "publish-trials": { type: "boolean", default: false },
    "publish-summaries": { type: "boolean", default: false },
  });
  const base = `${scopePath(values)}/releases`;
  if (action === "list") {
    const reply = await requestJson(base);
    return print(values, reply, () => releaseTable(reply.releases as Release[]));
  }
  if (action === "withdraw") {
    const id = encodeURIComponent(positional(positionals, 0, "RELEASE_ID"));
    const reply = await requestJson(`${base}/${id}/withdraw`, "POST");
    return print(values, reply, () => releaseTable([reply.release as Release]));
  }
  const view = (await requestJson(`${base}/preview`)) as unknown as ReleaseView;
  if (action === "preview") return print(values, view, () => previewView(view));
  if (action !== "publish") throw new Error("usage: self-bench release preview|publish|withdraw");
  const reply = await requestJson(base, "POST", {
    settings: chosenSettings(values, view.preview.settings),
    head: view.head?.id ?? null,
    fingerprint: view.preview.fingerprint,
    ...(values["publish-tasks"] === true ? { publishTasks: true } : {}),
    ...(values["publish-trials"] === true ? { publishTrials: true } : {}),
    ...(values["publish-summaries"] === true ? { publishSummaries: true } : {}),
  });
  print(values, reply, () => `Released.\n${releaseTable([reply.release as Release])}`);
}

/** `--setting` keys, every setting with `--all-settings`, or else the ones the app pre-ticks. */
function chosenSettings(values: Values, settings: PreviewSetting[]): string[] {
  const named = list(values, "setting");
  const keys = new Set(settings.map((setting) => setting.key));
  const unknown = named.filter((key) => !keys.has(key));
  if (unknown.length) throw new Error(`not in the preview: ${unknown.join(", ")}`);
  const chosen = named.length
    ? named
    : settings
        .filter((setting) => values["all-settings"] === true || setting.ticked)
        .map((setting) => setting.key);
  if (chosen.length === 0) throw new Error("no settings to release; run `release preview`");
  return chosen;
}

function previewView(view: ReleaseView): string {
  const { preview } = view;
  const settings = table(preview.settings, [
    ["SETTING", (setting) => `${setting.label} · ${setting.reasoningLevel} · ${setting.harness}`],
    ["TASKS RUN", (setting) => `${setting.coverage.length}/${preview.tasks.length}`],
    ["DEFAULT", (setting) => (setting.ticked ? "yes" : "")],
    ["KEY", (setting) => setting.key],
  ]);
  return `${preview.tasks.length} approved tasks, ${preview.unrun} unrun\n\n${settings}`;
}

/** `benchmarks`; `benchmark add|show|tasks|remove NAME`: Harbor registry datasets to evaluate. */
export async function benchmarkCommand(args: string[], listing: boolean): Promise<void> {
  const [action, ...rest] = listing ? ["list", ...args] : args;
  const { values, positionals } = parse(rest);
  const base = `/api/orgs/${encodeURIComponent(org(values))}/benchmarks`;
  if (action === "list") {
    const reply = await requestJson(base);
    const benchmarks = reply.benchmarks as {
      name: string;
      ref: string;
      tasks: number;
      status: string;
    }[];
    return print(values, reply, () =>
      table(benchmarks, [
        ["BENCHMARK", (benchmark) => benchmark.name],
        ["REF", (benchmark) => benchmark.ref],
        ["TASKS", (benchmark) => benchmark.tasks],
        ["STATUS", (benchmark) => benchmark.status],
      ]),
    );
  }
  const name = flag(values, "benchmark") ?? positional(positionals, 0, "NAME");
  if (action === "add") return print(values, await requestJson(base, "POST", { reference: name }));
  const path = `${base}/${name.split("/").map(encodeURIComponent).join("/")}`;
  if (action === "show") return print(values, await requestJson(path));
  if (action === "tasks") return print(values, await requestJson(`${path}/tasks`));
  if (action === "remove") return print(values, await requestJson(path, "DELETE"));
  throw new Error("usage: self-bench benchmark add|show|tasks|remove NAME");
}
