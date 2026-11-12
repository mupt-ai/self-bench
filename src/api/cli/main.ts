import { fail } from "../../lib/util.js";
import { download, passthrough } from "./api-client.js";
import { readConfig } from "./config.js";
import { credentialCommand } from "./credentials.js";
import { environmentCommand } from "./environments.js";
import {
  catalogCommand,
  compareCommand,
  comparisonCommand,
  evaluationRunCommand,
  resultsCommand,
  summariesCommand,
} from "./evaluations.js";
import { groupCommand } from "./groups.js";
import { printHelp } from "./help.js";
import { loginCommand, logoutCommand, orgCommand } from "./login.js";
import { memberCommand, membersCommand, workspaceCommand } from "./members.js";
import { grantCommand } from "./operator.js";
import { benchmarkCommand, releaseCommand } from "./releases.js";
import { savedConditionCommand } from "./saved-conditions.js";
import { scenarioCommand, taskCommand } from "./tasks.js";
import { interactive } from "./tui.js";
import { requiredArgument } from "./values.js";
import {
  batchCommand,
  evalCommand,
  generateCommand,
  prsCommand,
  repoCommand,
  whoamiCommand,
} from "./workspace.js";

type Command = (args: string[]) => Promise<void>;

/** Each command, by name; plurals list, singulars act on one. */
const COMMANDS: Record<string, Command> = {
  login: loginCommand,
  logout: logoutCommand,
  org: orgCommand,
  whoami: whoamiCommand,
  workspace: workspaceCommand,
  members: membersCommand,
  member: memberCommand,
  credentials: (args) => credentialCommand(args, true),
  credential: (args) => credentialCommand(args, false),
  repos: (args) => repoCommand(args, true),
  repo: (args) => repoCommand(args, false),
  eval: evalCommand,
  prs: prsCommand,
  generate: generateCommand,
  batches: (args) => batchCommand(args, true),
  batch: (args) => batchCommand(args, false),
  scenario: scenarioCommand,
  tasks: (args) => taskCommand(args, true),
  task: (args) => taskCommand(args, false),
  environments: (args) => environmentCommand(args, true),
  environment: (args) => environmentCommand(args, false),
  conditions: (args) => savedConditionCommand(args, true),
  condition: (args) => savedConditionCommand(args, false),
  catalog: catalogCommand,
  compare: compareCommand,
  comparisons: (args) => comparisonCommand(args, true),
  comparison: (args) => comparisonCommand(args, false),
  runs: (args) => evaluationRunCommand(args, true),
  run: (args) => evaluationRunCommand(args, false),
  results: resultsCommand,
  summaries: summariesCommand,
  releases: (args) => releaseCommand(args, true),
  release: (args) => releaseCommand(args, false),
  benchmarks: (args) => benchmarkCommand(args, true),
  benchmark: (args) => benchmarkCommand(args, false),
  groups: (args) => groupCommand(args, true),
  group: (args) => groupCommand(args, false),
  // Operator commands, on the deployment's own token.
  status: (args) => passthrough("GET", `/v1/runs/${requiredArgument(args, "run ID")}`),
  cancel: (args) => passthrough("POST", `/v1/runs/${requiredArgument(args, "run ID")}/cancel`),
  list: () => passthrough("GET", "/v1/runs"),
  download: (args) =>
    download(requiredArgument(args, "run ID"), args[1] ?? fail("output path is required")),
  grant: grantCommand,
};

export async function runCli(args: string[]): Promise<void> {
  const [command, ...rest] = args;
  if (command === "help" || command === "--help" || command === "-h") return printHelp();
  // Bare `self-bench` signs in first, as `dari` does, then shows what it can do.
  if (command === undefined) return await welcome();
  const run = COMMANDS[command];
  if (!run) throw new Error(`unknown command: ${command} (see self-bench help)`);
  await run(rest);
}

async function welcome(): Promise<void> {
  if (!process.env.SELFBENCH_API_KEY && !readConfig().apiKey && interactive())
    await loginCommand([]);
  printHelp();
}
