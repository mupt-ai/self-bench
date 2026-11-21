import { out } from "./style.js";

/**
 * `self-bench help`, laid out like `dari --help`: a short top level that lists each command with
 * one line, grouped, and `self-bench NOUN --help` (or `NOUN VERB --help`) for the detail.
 */

type Flag = [usage: string, summary: string];

interface Verb {
  name: string;
  /** Positionals and required flags, after `self-bench NOUN VERB`. */
  args?: string;
  summary: string;
  long?: string;
  flags?: Flag[];
}

interface Noun {
  name: string;
  summary: string;
  long?: string;
  /** For a noun that runs on its own (`login`, `results`): what follows `self-bench NOUN`. */
  args?: string;
  flags?: Flag[];
  verbs?: Verb[];
  /** `NOUN SUBNOUN VERB`: nouns nested under this one, such as `repo batch`. */
  nouns?: Noun[];
}

interface Group {
  title: string;
  nouns: Noun[];
}

const S = "--repo OWNER/NAME | --custom NAME | --public ORG/NAME | --group SLUG";
const B = "--repo OWNER/NAME | --custom NAME";
const R = "--repo OWNER/NAME";

const WRITER_FLAGS: Flag[] = [
  ["--model ID", "the model that writes the task (default: managed)"],
  ["--verifier-model ID", "the model that checks it"],
  ["--reasoning LEVEL", "the writer's reasoning level"],
  ["--model-credential ID", "a saved model credential to pay with"],
  ["--sandbox KIND", "where it builds: managed, e2b, modal, daytona, or vercel"],
  ["--sandbox-credential ID", "a saved sandbox credential"],
  ["--harbor ENV --harbor-credential ID", "a Harbor environment and its credential"],
  ["--generation JSON|@FILE", "all of the above as one object"],
];

const WAIT: Flag = ["--wait", "wait and print the answer"];

const GROUPS: Group[] = [
  {
    title: "Get Started",
    nouns: [
      {
        name: "login",
        summary: "Sign in through your browser; saves a key and workspace",
        long: "Sign in through your browser and save a personal API key and workspace.\n\nIn CI, set SELFBENCH_API_KEY (Settings → API Keys) and SELFBENCH_ORG instead.\nSELFBENCH_API_URL points at another deployment.",
        flags: [
          ["--api-url URL", "sign in to a self-hosted deployment"],
          ["--no-browser", "print the sign-in address instead of opening it"],
        ],
      },
      { name: "logout", summary: "Revoke the saved key and forget it" },
      { name: "whoami", summary: "Show your account, its workspaces, and the key's scope" },
      {
        name: "org",
        args: "[use [NAME]]",
        summary: "Show or change the workspace commands act in",
        long: "Show the workspace commands act in; `org use` changes it. --org NAME overrides it once.",
      },
    ],
  },
  {
    title: "Benchmarks",
    nouns: [
      {
        name: "repo",
        summary: "Repo Benchmarks: tasks from a connected repository's merged PRs",
        verbs: [
          { name: "list", summary: "List connected repositories" },
          { name: "connect", args: "OWNER/NAME", summary: "Connect a repository" },
          { name: "show", args: "OWNER/NAME", summary: "Show a repository" },
          {
            name: "update",
            args: "OWNER/NAME --agent-minutes N",
            summary: "Set how long an agent gets per task",
          },
          { name: "disconnect", args: "OWNER/NAME", summary: "Disconnect a repository" },
        ],
        nouns: [
          {
            name: "pr",
            summary: "List merged pull requests",
            verbs: [
              {
                name: "list",
                args: R,
                summary: "List merged pull requests",
                flags: [["--page N", "page of results"]],
              },
            ],
          },
          {
            name: "batch",
            summary: "Write many tasks at once from merged PRs or features",
            verbs: [
              {
                name: "create",
                args: `${R} (--easy N --medium N --hard N | --features --hard N)`,
                summary: "Pick merged PRs, or features, and write a task from each",
                long: "Pick merged PRs and write a task from each, or with --features, find features built over\nseveral merged PRs and write an end-to-end task from each.",
                flags: [
                  ["--easy N, --medium N, --hard N", "how many tasks of each difficulty"],
                  ["--features", "write tasks from features rather than single PRs"],
                  ["--focus TEXT", "steer which PRs (or the one feature) to pick"],
                  ...WRITER_FLAGS,
                ],
              },
              { name: "list", args: R, summary: "List batches" },
              { name: "show", args: `BATCH ${R}`, summary: "Show a batch's progress" },
              { name: "cancel", args: `BATCH ${R}`, summary: "Stop a batch" },
            ],
          },
          {
            name: "environment",
            summary: "Bash scripts run in every approved task's image, for ablations",
            long: "A Bash script run in every approved task's image. Run one with\n`comparison create --environment ID`.",
            verbs: [
              { name: "list", args: R, summary: "List environments and how many tasks are ready" },
              {
                name: "create",
                args: `${R} --name TEXT (--script TEXT | --script-file FILE)`,
                summary: "Build every approved task with the script run",
                flags: WRITER_FLAGS,
              },
              { name: "show", args: `ID ${R}`, summary: "Show each task's build and check" },
              {
                name: "build",
                args: `ID ${R}`,
                summary: "Build tasks approved since, or that failed",
                flags: WRITER_FLAGS,
              },
              { name: "delete", args: `ID ${R}`, summary: "Delete an environment" },
            ],
          },
        ],
      },
      {
        name: "custom",
        summary: "Custom Benchmarks: tasks written from your descriptions",
        long: "Custom Benchmarks hold tasks written from your descriptions, with no repository behind\nthem. Add tasks with `task create --custom NAME --title TEXT --description TEXT`.",
        verbs: [
          { name: "list", summary: "List custom benchmarks" },
          { name: "create", args: "NAME", summary: "Create one; then pass --custom NAME" },
          { name: "show", args: "NAME", summary: "Show one" },
          {
            name: "update",
            args: "NAME --agent-minutes N",
            summary: "Set how long an agent gets per task",
          },
          { name: "delete", args: "NAME", summary: "Delete one" },
        ],
      },
      {
        name: "public",
        summary: "Public Benchmarks: Harbor registry datasets such as Terminal-Bench",
        verbs: [
          { name: "list", summary: "List datasets added to this workspace" },
          {
            name: "add",
            args: "ORG/NAME[@REF]",
            summary: "Add one; its tasks are frozen when added",
          },
          { name: "show", args: "ORG/NAME", summary: "Show one" },
          { name: "tasks", args: "ORG/NAME", summary: "List its tasks" },
          { name: "remove", args: "ORG/NAME", summary: "Remove one" },
        ],
      },
      {
        name: "group",
        summary: "Repo groups: repositories evaluated and released together",
        verbs: [
          { name: "list", summary: "List repo groups" },
          {
            name: "create",
            args: "SLUG --name TEXT --member OWNER/NAME [--member ...]",
            summary: "Create a group",
            flags: [["--description TEXT", "what the group is"]],
          },
          {
            name: "update",
            args: "SLUG --name TEXT --member OWNER/NAME [--member ...]",
            summary: "Replace a group's name and members",
            flags: [["--description TEXT", "what the group is"]],
          },
          { name: "show", args: "SLUG", summary: "Show a group" },
          { name: "delete", args: "SLUG", summary: "Delete a group" },
        ],
      },
    ],
  },
  {
    title: "Tasks",
    nouns: [
      {
        name: "task",
        summary: "Create, review, fix, and inspect tasks",
        long: "Create, review, fix, and inspect tasks. TASK is RUN_ID/TASK_ID, as `task list` prints it.\nOnly approved tasks are evaluated.",
        verbs: [
          {
            name: "list",
            args: B,
            summary: "List tasks",
            flags: [["--state STATE", "needs_review, accepted, rejected, in_progress, or failed"]],
          },
          {
            name: "create",
            args: `${B} (--pr NUMBER|URL | --title TEXT --description TEXT)`,
            summary: "Write a task from a merged PR or from your description",
            flags: [
              ["--pr NUMBER|URL", "a merged pull request (Repo Benchmarks)"],
              ["--title TEXT", "a custom task's title"],
              ["--description TEXT", "what it should test (or --description-file FILE)"],
              ["--commit SHA|BRANCH", "the commit a custom task starts from"],
              ["--difficulty LEVEL", "easy, medium, or hard"],
              ["--attach FILE", "a file for the writer to use (repeatable)"],
              ...WRITER_FLAGS,
            ],
          },
          {
            name: "feedback",
            args: 'TASK_URL "TEXT"',
            summary: "Steer a task while it generates, or revise it once done",
            long: "The quickest way to fix a task: steer it while it generates, or revise it once done.\nTASK_URL is its page in the app; `OWNER/NAME RUN_ID TASK_ID` names it without one.",
            flags: [
              ["--feedback-file FILE|-", "read the text from a file, or - for stdin"],
              ["--from-audit", "send the task's latest fairness audit, after your own text"],
              ...WRITER_FLAGS,
            ],
          },
          {
            name: "show",
            args: `TASK ${B}`,
            summary: "Show the task, its review, cost, and revisions",
          },
          { name: "pull", args: `TASK [DIR] ${B}`, summary: "Download its files" },
          {
            name: "revise",
            args: `TASK ${B} (--feedback TEXT | --feedback-file FILE)`,
            summary: "Rewrite a finished task from feedback",
            flags: [["--draft DIR", "your own edits to start from"], ...WRITER_FLAGS],
          },
          {
            name: "steer",
            args: `TASK ${B} (--feedback TEXT | --feedback-file FILE)`,
            summary: "Leave a note its writer reads at its next turn",
          },
          {
            name: "steering",
            args: `TASK ${B}`,
            summary: "List notes sent and the turn that read each",
          },
          {
            name: "approve",
            args: `TASK ${B}`,
            summary: "Approve a task",
            flags: [["--note TEXT", "why"]],
          },
          {
            name: "reject",
            args: `TASK ${B}`,
            summary: "Reject a task",
            flags: [["--note TEXT", "why"]],
          },
          { name: "unreview", args: `TASK ${B}`, summary: "Clear its review" },
          { name: "cancel", args: `TASK ${B}`, summary: "Stop generating it" },
          { name: "delete", args: `TASK ${B}`, summary: "Delete it" },
          {
            name: "results",
            args: `TASK ${S}`,
            summary: "Every configuration on one task, with failure explanations",
          },
          {
            name: "explain",
            args: `TASK ${S}`,
            summary: "Explain why its failures failed",
            flags: [
              ["--config KEY", "one configuration, as `results` names it"],
              ["--model ID --credential ID", "the model that explains"],
              WAIT,
            ],
          },
          {
            name: "audit",
            args: `TASK ${S} --model ID --credential ID`,
            summary: "Judge whether the task is fair",
            flags: [WAIT],
          },
        ],
      },
    ],
  },
  {
    title: "Evaluate",
    nouns: [
      {
        name: "comparison",
        summary: "Run models on a benchmark's approved tasks",
        verbs: [
          {
            name: "create",
            args: `${S} --model ID [--model ID ...]`,
            summary: "Run each model on every approved task",
            flags: [
              ["--harness AGENT", "the agent harness (repeatable)"],
              ["--thinking LEVEL", "thinking level"],
              ["--credential ID", "a saved model credential"],
              ["--sandbox KIND", "managed, e2b, modal, daytona, or vercel"],
              ["--sandbox-credential ID", "a saved sandbox credential"],
              ["--task TASK", "only these tasks (repeatable)"],
              ["--skip-completed", "skip configurations already run"],
              ["--judge-credential ID", "the credential that explains failures"],
              ["--saved-harness ID", "a saved harness (repeatable)"],
              ["--environment ID", "a repo environment (repeatable)"],
              ["--no-baseline", "skip the plain harness when saved ones are given"],
              ["--selection JSON|@FILE", "the whole selection as one object"],
            ],
          },
          { name: "list", args: S, summary: "List comparisons" },
          { name: "show", args: `ID ${S}`, summary: "Show a comparison" },
          { name: "resume", args: `ID ${S}`, summary: "Resume a stopped comparison" },
          { name: "cancel", args: `ID ${S}`, summary: "Cancel a comparison" },
          {
            name: "models",
            args: S,
            summary: "List models an evaluation can use",
            flags: [["--harness AGENT", "list the options a saved harness can set on AGENT"]],
          },
        ],
        nouns: [
          {
            name: "run",
            summary: "One model's run in a comparison, with its trials",
            verbs: [
              { name: "list", args: S, summary: "List runs" },
              { name: "show", args: `ID ${S}`, summary: "Show a run and its trials" },
              { name: "cancel", args: `ID ${S}`, summary: "Cancel a run" },
              { name: "delete", args: `ID ${S}`, summary: "Delete a run" },
            ],
          },
        ],
      },
      {
        name: "harness",
        summary: "Saved agent changes (skills, instructions, options) to compare",
        verbs: [
          { name: "list", summary: "List saved harnesses and what each changes" },
          {
            name: "create",
            args: "--name TEXT",
            summary: "Save a harness",
            flags: [
              ["--agent AGENT", "the agent it changes"],
              ["--skill ORG/REPO[@REF]", "a skill to install (repeatable)"],
              ["--instructions TEXT", "added instructions (or --instructions-file FILE)"],
              ["--option AGENT.OPTION=VALUE|@FILE", "an agent option (repeatable)"],
              ["--subagent-model ID", "a subagent's model"],
              ["--subagent-prompt TEXT", "its prompt (or --subagent-prompt-file FILE)"],
              ["--subagent-credential ID", "its credential"],
              ["--subagent-thinking LEVEL", "its thinking level"],
              ["--body JSON|@FILE", "the whole harness as one object"],
            ],
          },
          {
            name: "update",
            args: "ID",
            summary: "Replace a harness (create's flags); past runs keep theirs",
          },
          { name: "show", args: "ID", summary: "Show a harness" },
          { name: "delete", args: "ID", summary: "Delete a harness" },
        ],
      },
      {
        name: "results",
        args: S,
        summary: "Pass rate and cost per configuration",
        nouns: [
          {
            name: "summary",
            summary: "Model Summaries: how configurations differ",
            verbs: [
              { name: "show", args: S, summary: "Show the latest report" },
              {
                name: "create",
                args: `${S} --model ID --credential ID`,
                summary: "Write a new report",
                flags: [["--config KEY", "only these configurations (repeatable)"], WAIT],
              },
            ],
          },
        ],
      },
      {
        name: "release",
        summary: "Publish results to selfbench.dev",
        verbs: [
          { name: "preview", args: S, summary: "Show what a release would publish" },
          {
            name: "publish",
            args: S,
            summary: "Release the preview it just read",
            flags: [
              ["--setting KEY", "only these settings (repeatable)"],
              ["--all-settings", "every setting"],
              ["--publish-tasks", "publish the tasks"],
              ["--publish-trials", "publish each setting's result by task"],
              ["--publish-summaries", "publish Model Summaries"],
            ],
          },
          { name: "list", args: S, summary: "List releases" },
          { name: "withdraw", args: `ID ${S}`, summary: "Withdraw a release" },
        ],
      },
    ],
  },
  {
    title: "Workspace",
    nouns: [
      {
        name: "workspace",
        summary: "Manage the workspace, its members, and credentials",
        verbs: [
          {
            name: "create",
            args: "NAME",
            summary: "Create a shared workspace you administer",
            flags: [["--name TEXT", "display name"]],
          },
          {
            name: "connect",
            args: "GITHUB_ORG",
            summary: "Move a GitHub org's members and repos here",
          },
          { name: "rename", args: "TEXT", summary: "Set the display name; NAME never changes" },
        ],
        nouns: [
          {
            name: "member",
            summary: "People, roles, and invites",
            verbs: [
              { name: "list", summary: "List people, roles, and connected GitHub orgs" },
              {
                name: "invite",
                args: "LOGIN",
                summary: "Invite a GitHub user; they join at next sign-in",
                flags: [["--role admin|member", "their role"]],
              },
              { name: "invites", summary: "List pending invites" },
              { name: "revoke", args: "ID", summary: "Withdraw an invite" },
              { name: "role", args: "LOGIN admin|member", summary: "Change a member's role" },
              { name: "remove", args: "LOGIN", summary: "Remove a member" },
            ],
          },
          {
            name: "credential",
            summary: "Model and sandbox credentials (admins)",
            verbs: [
              { name: "list", summary: "List saved credentials, with the IDs flags take" },
              {
                name: "add",
                summary: "Pick a provider and paste a key",
                long: "Pick a provider and paste a key. Without a terminal, pass --kind and the value.\nPlans connect in the app, with Connect with Dari.",
                flags: [
                  ["--kind KIND", "the provider"],
                  ["--value-env VAR | --value-stdin", "where to read the key"],
                  ["--name NAME", "a name for it"],
                  ["--token-id ID", "Modal token ID"],
                  ["--team-id ID --project-id ID", "Vercel team and project"],
                  ["--endpoint URL", "a custom endpoint"],
                ],
              },
              { name: "rename", args: "ID NAME", summary: "Rename a credential" },
              { name: "remove", args: "ID", summary: "Remove a credential" },
            ],
          },
        ],
      },
    ],
  },
];

const OPERATOR: Noun = {
  name: "operator",
  summary: "Deployment operator commands (SELFBENCH_API_TOKEN)",
  nouns: [
    {
      name: "run",
      summary: "Batch runs across the deployment",
      verbs: [
        { name: "list", summary: "List runs" },
        { name: "show", args: "RUN_ID", summary: "Show a run" },
        { name: "cancel", args: "RUN_ID", summary: "Cancel a run" },
        {
          name: "download",
          args: "RUN_ID OUT.tar.gz",
          summary: "Download a batch's Harbor export, checked against its SHA-256",
        },
      ],
    },
    {
      name: "grant",
      summary: "Task access grants",
      verbs: [
        {
          name: "create",
          args: "--label TEXT --task ID [--task ID ...]",
          summary: "Grant access to tasks",
          flags: [
            ["--days N", "how long it lasts"],
            ["--with-verifier", "include the verifier"],
          ],
        },
        { name: "list", summary: "List grants" },
        { name: "revoke", args: "GRANT_ID", summary: "Revoke a grant" },
      ],
    },
  ],
};

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
export const MOVED: Record<string, string[]> = {
  pr: ["repo", "pr"],
  batch: ["repo", "batch"],
  environment: ["repo", "environment"],
  member: ["workspace", "member"],
  credential: ["workspace", "credential"],
  feedback: ["task", "feedback"],
  evaluation: ["comparison", "run"],
  catalog: ["comparison", "models"],
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
