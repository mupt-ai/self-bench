import { customCommand, evalCommand, publicCommand } from "./benchmarks.js";
import { readConfig } from "./config.js";
import { credentialCommand } from "./credentials.js";
import { environmentCommand } from "./environments.js";
import {
  catalogCommand,
  comparisonCommand,
  evaluationCommand,
  resultsCommand,
  summaryCommand,
} from "./evaluations.js";
import { feedbackCommand } from "./feedback.js";
import { groupCommand } from "./groups.js";
import { ACTION_NOUNS, printHelp } from "./help.js";
import { loginCommand, logoutCommand, orgCommand } from "./login.js";
import { memberCommand, workspaceCommand } from "./members.js";
import { grantCommand, operatorCommand, runCommand } from "./operator.js";
import { releaseCommand } from "./releases.js";
import { savedHarnessCommand } from "./saved-harnesses.js";
import { scenarioCommand } from "./task-create.js";
import { taskCommand } from "./tasks.js";
import { interactive } from "./tui.js";
import { batchCommand, prCommand, repoCommand, whoamiCommand } from "./workspace.js";

type Command = (args: string[]) => Promise<void>;

/** Each command, by noun; the verb is its first argument (`task list`, `repo connect`). */
const COMMANDS: Record<string, Command> = {
  login: loginCommand,
  logout: logoutCommand,
  org: orgCommand,
  whoami: whoamiCommand,
  workspace: workspaceCommand,
  member: memberCommand,
  credential: credentialCommand,
  repo: repoCommand,
  pr: prCommand,
  batch: batchCommand,
  group: groupCommand,
  custom: customCommand,
  public: publicCommand,
  feedback: feedbackCommand,
  task: taskCommand,
  environment: environmentCommand,
  harness: savedHarnessCommand,
  catalog: catalogCommand,
  comparison: comparisonCommand,
  evaluation: evaluationCommand,
  results: resultsCommand,
  summary: summaryCommand,
  release: releaseCommand,
  operator: operatorCommand,
};

/** `NOUN …` as `NOUN VERB …`. */
const verb =
  (command: Command, name: string): Command =>
  (args) =>
    command([name, ...args]);

/**
 * Shorter and older names, which help leaves out but scripts may use: plurals list (`repos` is
 * `repo list`), and each name a command had before it was renamed.
 */
const ALIASES: Record<string, Command> = {
  members: verb(memberCommand, "list"),
  credentials: verb(credentialCommand, "list"),
  repos: verb(repoCommand, "list"),
  prs: verb(prCommand, "list"),
  batches: verb(batchCommand, "list"),
  groups: verb(groupCommand, "list"),
  tasks: verb(taskCommand, "list"),
  environments: verb(environmentCommand, "list"),
  harnesses: verb(savedHarnessCommand, "list"),
  comparisons: verb(comparisonCommand, "list"),
  evaluations: verb(evaluationCommand, "list"),
  releases: verb(releaseCommand, "list"),
  // Renamed with Repo, Custom, and Public Benchmarks.
  eval: evalCommand,
  scenario: scenarioCommand,
  generate: verb(batchCommand, "create"),
  benchmarks: verb(publicCommand, "list"),
  benchmark: publicCommand,
  compare: verb(comparisonCommand, "create"),
  runs: verb(evaluationCommand, "list"),
  run: evaluationCommand,
  summaries: (args) => summaryCommand(args[0] === "create" ? args : ["show", ...args]),
  conditions: verb(savedHarnessCommand, "list"),
  condition: savedHarnessCommand,
  // Operator commands, once top-level.
  status: verb(runCommand, "show"),
  cancel: verb(runCommand, "cancel"),
  list: verb(runCommand, "list"),
  download: verb(runCommand, "download"),
  grant: grantCommand,
};

/** Commands nested under a noun (`repo batch create`), each also reachable by its older name. */
const NESTED: Record<string, Record<string, Command>> = {
  repo: { pr: prCommand, batch: batchCommand, environment: environmentCommand },
  workspace: { member: memberCommand, credential: credentialCommand },
  task: { feedback: feedbackCommand },
  comparison: { run: evaluationCommand, models: catalogCommand },
  results: { summary: summaryCommand },
};

export async function runCli(args: string[]): Promise<void> {
  const [command, ...rest] = args;
  if (command === "help" || command === "--help" || command === "-h") return printHelp(rest);
  // Bare `self-bench` signs in first, as `dari` does, then shows what it can do.
  if (command === undefined) return await welcome();
  const nested = NESTED[command]?.[rest[0] ?? ""];
  const run = nested ?? COMMANDS[command] ?? ALIASES[command];
  if (!run) throw new Error(`unknown command: ${command} (see self-bench --help)`);
  const words = nested ? [command, rest[0] ?? ""] : [command];
  const after = nested ? rest.slice(1) : rest;
  // `self-bench task` alone, or `self-bench task create --help`, shows that command's help.
  const asked = after.includes("--help") || after.includes("-h");
  const bare = after.length === 0 && (nested ? run !== catalogCommand : ACTION_NOUNS.has(command));
  if (asked || bare) return printHelp([...words, ...after.filter((word) => !word.startsWith("-"))]);
  await run(after);
}

async function welcome(): Promise<void> {
  if (!process.env.SELFBENCH_API_KEY && !readConfig().apiKey && interactive())
    await loginCommand([]);
  printHelp();
}
