import { GET_STARTED, OPERATOR, WORKSPACE } from "./help-account.js";
import { BENCHMARKS } from "./help-benchmarks.js";
import { EVALUATE, TASKS } from "./help-evaluate.js";
import type { Flag, Group, Noun, Verb } from "./help-spec.js";
import { out } from "./style.js";

/**
 * `self-bench help`, laid out like `dari --help`: a short top level that lists each command with
 * one line, grouped, and `self-bench NOUN --help` (or `NOUN VERB --help`) for the detail.
 */

const GROUPS: Group[] = [GET_STARTED, BENCHMARKS, TASKS, EVALUATE, WORKSPACE];

const NOUNS: Noun[] = [...GROUPS.flatMap((group) => group.nouns), OPERATOR];

const GLOBAL_FLAGS: Flag[] = [
  ["--org NAME", "act in this workspace once"],
  ["--json", "print JSON (the default when piped)"],
  ["-h, --help", "help for any command"],
];

const DOCS = "Docs: https://docs.selfbench.dev/cli/overview";

/** Aligned `name  summary` rows; names painted after padding, so color never shifts columns. */
function columns(rows: [string, string][], paint: (text: string) => string = out.accent): string {
  const width = Math.max(...rows.map(([left]) => left.length)) + 2;
  return rows.map(([left, right]) => `  ${paint(left.padEnd(width))}${right}`).join("\n");
}

const heading = (text: string) => out.bold(text);
const flags = (rows: Flag[]) => columns(rows, out.cyan);
const footer = (name: string) =>
  out.dim(`Use "${name} [command] --help" for more information about a command.`);

const TAGLINE = "Build coding-agent benchmarks, run models on them, and publish results.";

function root(): string {
  return [
    `${out.accent("◆")} ${out.bold("selfbench")}  ${out.dim(TAGLINE)}`,
    `${heading("Usage")}\n  self-bench ${out.dim("[command]")}`,
    ...GROUPS.map(
      (group) =>
        `${heading(group.title)}\n${columns(group.nouns.map((noun) => [noun.name, noun.summary]))}`,
    ),
    `${heading("Additional Commands")}\n${columns([
      [OPERATOR.name, OPERATOR.summary],
      ["help", "Help about any command"],
    ])}`,
    `${heading("Flags")}\n${flags(GLOBAL_FLAGS)}`,
    footer("self-bench"),
    out.dim(DOCS),
  ].join("\n\n");
}

function nounHelp(path: string[], noun: Noun): string {
  const name = `self-bench ${path.join(" ")}`;
  const argText = noun.args ? ` ${out.dim(noun.args)}` : "";
  const rows: [string, string][] = [
    ...(noun.verbs ?? []).map((verb): [string, string] => [verb.name, verb.summary]),
    ...(noun.nouns ?? []).map((sub): [string, string] => [sub.name, sub.summary]),
  ];
  const usage = [
    ...(rows.length === 0 || noun.args ? [`${name}${argText}`] : []),
    ...(rows.length ? [`${name} ${out.dim("[command]")}`] : []),
  ];
  return [
    noun.long ?? noun.summary,
    `${heading("Usage")}\n${usage.map((line) => `  ${line}`).join("\n")}`,
    ...(rows.length ? [`${heading("Commands")}\n${columns(rows)}`] : []),
    ...(noun.flags ? [`${heading("Flags")}\n${flags(noun.flags)}`] : []),
    `${heading("Global Flags")}\n${flags(GLOBAL_FLAGS)}`,
    ...(rows.length ? [footer(name)] : []),
  ].join("\n\n");
}

function verbHelp(path: string[], verb: Verb): string {
  return [
    verb.long ?? verb.summary,
    `${heading("Usage")}\n  self-bench ${[...path, verb.name].join(" ")}${verb.args ? ` ${out.dim(verb.args)}` : ""}`,
    ...(verb.flags ? [`${heading("Flags")}\n${flags(verb.flags)}`] : []),
    `${heading("Global Flags")}\n${flags(GLOBAL_FLAGS)}`,
  ].join("\n\n");
}

/** Older top-level nouns, now nested or renamed, so `self-bench pr --help` still finds its help. */
const MOVED: Record<string, string[]> = {
  pr: ["repo", "pr"],
  batch: ["repo", "batch"],
  environment: ["repo", "environment"],
  member: ["workspace", "member"],
  credential: ["workspace", "credential"],
  feedback: ["task", "feedback"],
  evaluation: ["run"],
  catalog: ["run", "models"],
  summary: ["results", "summary"],
};

/**
 * Help for the command `words` name (`[]`, `["task"]`, `["task", "create"]`,
 * `["repo", "batch", "create"]`), from the deepest word it recognizes.
 */
export function helpText(words: string[]): string {
  const [first, ...more] = words.filter((word) => !word.startsWith("-"));
  if (!first) return root();
  const path = [...(MOVED[first] ?? [first]), ...more];
  const top = NOUNS.find((candidate) => candidate.name === path[0]);
  if (!top) return root();
  let noun: Noun = top;
  const at = [noun.name];
  for (const word of path.slice(1)) {
    const sub: Noun | undefined = noun.nouns?.find((candidate) => candidate.name === word);
    if (sub) {
      noun = sub;
      at.push(word);
      continue;
    }
    const verb = noun.verbs?.find((candidate) => candidate.name === word);
    if (verb) return verbHelp(at, verb);
    break;
  }
  return nounHelp(at, noun);
}

export function printHelp(words: string[] = []): void {
  console.log(helpText(words));
}

/** Nouns that do nothing alone, so `self-bench NOUN` shows their help instead. */
export const ACTION_NOUNS = new Set([
  ...NOUNS.filter((noun) => (noun.verbs || noun.nouns) && !noun.args).map((noun) => noun.name),
  ...Object.keys(MOVED).filter((name) => name !== "catalog"),
]);
