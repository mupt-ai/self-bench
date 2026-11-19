const INTRO = `self-bench: build coding-agent benchmarks, run models on them, and publish results.

Usage: self-bench NOUN VERB [ARGS] [FLAGS]       self-bench help NOUN shows one section

Benchmarks: commands that read or run tasks name one (S below)
  --repo OWNER/NAME    a Repo Benchmark: tasks from a connected repository's merged PRs
  --custom NAME        a Custom Benchmark: tasks written from your descriptions, no repository
  --public ORG/NAME    a Public Benchmark: a Harbor registry dataset, such as terminal-bench/...
  --group SLUG         a repo group: repositories evaluated and released together
  TASK is RUN_ID/TASK_ID, as task list prints it. Every command takes --org NAME and --json;
  lists print tables on a terminal and JSON when piped. Plurals list: repos is repo list.`;

/** One section of `self-bench help`, and the nouns whose `help NOUN` shows it. */
interface Section {
  nouns: string[];
  text: string;
}

const SECTIONS: Section[] = [
  {
    nouns: ["login", "logout", "whoami", "org"],
    text: `Setup
  login [--api-url URL] [--no-browser]       sign in through your browser; saves a key and workspace
  logout                                     revoke the saved key and forget it
  whoami                                     the account, its workspaces, and the key's scope
  org | org use [NAME]                       show or change the workspace commands act in
  In CI, set SELFBENCH_API_KEY (Settings → API Keys) and SELFBENCH_ORG instead of logging in;
  SELFBENCH_API_URL points at another deployment.`,
  },
  {
    nouns: ["workspace", "member"],
    text: `Workspace
  workspace create NAME [--name TEXT]        a shared workspace you administer
  workspace connect GITHUB_ORG               move a GitHub org's members and repos here
  workspace rename TEXT                      set the display name; NAME never changes
  member list                                people, roles, and connected GitHub orgs
  member invite LOGIN [--role admin|member]  invite a GitHub user; they join at next sign-in
  member invites | member revoke ID          pending invites; withdraw one
  member role LOGIN admin|member             change a member's role
  member remove LOGIN                        remove an invited member`,
  },
  {
    nouns: ["credential"],
    text: `Credentials (workspace admins)
  credential list                            saved credentials, with the IDs flags take
  credential add                             pick a provider, then paste a key; plans connect in the
                                             app, with Connect with Dari
  credential add --kind KIND (--value-env VAR | --value-stdin) [--name NAME]
      [--token-id ID] [--team-id ID --project-id ID] [--endpoint URL]
  credential rename ID NAME | credential remove ID`,
  },
  {
    nouns: ["repo", "pr", "batch", "group"],
    text: `Repo Benchmarks (R is --repo OWNER/NAME)
  repo list                                  connected repositories
  repo connect|show|disconnect OWNER/NAME
  repo update OWNER/NAME --agent-minutes N   how long an agent gets per task
  pr list R [--page N]                       merged pull requests
  batch create R --easy N --medium N --hard N [--focus TEXT]
                                             pick merged PRs and write a task from each
  batch list R | batch show|cancel BATCH R   follow or stop batches
  group list | group show|delete SLUG        repo groups
  group create|update SLUG --name TEXT --member OWNER/NAME [--member ...] [--description TEXT]`,
  },
  {
    nouns: ["custom"],
    text: `Custom Benchmarks
  custom list                                the workspace's custom benchmarks
  custom create NAME                         a new one; then pass --custom NAME
  custom show|delete NAME
  custom update NAME --agent-minutes N       how long an agent gets per task
  Add tasks with task create --custom NAME --title TEXT --description TEXT.`,
  },
  {
    nouns: ["public"],
    text: `Public Benchmarks
  public list                                Harbor datasets added to this workspace
  public add ORG/NAME[@REF]                  add one; its tasks are frozen when added
  public show|tasks|remove ORG/NAME`,
  },
  {
    nouns: ["feedback", "task"],
    text: `Feedback (the quickest way to fix a task)
  feedback TASK_URL "TEXT"                   steer it while it generates, or revise it once done
  feedback OWNER/NAME RUN_ID TASK_ID "TEXT"  the same, named without its URL
      [--feedback-file FILE | -] [--from-audit]
  TASK_URL is the task's page in the app. - reads the text from stdin; --from-audit sends the
  task's latest fairness audit, after any text of your own.`,
  },
  {
    nouns: ["task"],
    text: `Tasks (B is --repo OWNER/NAME or --custom NAME)
  task list B [--state STATE]                needs_review, accepted, rejected, in_progress, failed
  task create R --pr NUMBER|URL              a task from one merged pull request
  task create B --title TEXT (--description TEXT | --description-file FILE)
      [--commit SHA|BRANCH] [--difficulty easy|medium|hard] [--attach FILE ...]
                                             a custom task, written from your description
  task show TASK B                           the task, its review, cost, and revisions
  task pull TASK [DIR] B                     download its files (DIR defaults to its TASK_ID)
  task revise TASK B (--feedback TEXT | --feedback-file FILE) [--draft DIR]
                                             rewrite a finished task from feedback and edits
  task steer TASK B (--feedback TEXT | --feedback-file FILE)
                                             a note its author reads at its next turn
  task steering TASK B                       notes sent, and the turn that received each
  task approve|reject TASK B [--note TEXT]   review it; only approved tasks are evaluated
  task unreview|cancel|delete TASK B         clear the review, stop generating, or delete

  batch create, task create, task revise, feedback, and environment create|build choose how
  tasks are written: --model ID, --verifier-model ID, --reasoning LEVEL, --model-credential ID,
  --sandbox KIND, --sandbox-credential ID, --harbor ENV, --harbor-credential ID, or
  --generation JSON|@FILE. Without them: managed models and sandbox.`,
  },
  {
    nouns: ["environment"],
    text: `Environments (a Bash script run in every approved task's image; R is --repo OWNER/NAME)
  environment list R                         each one, and how many of its tasks are ready
  environment create R --name TEXT (--script TEXT | --script-file FILE)
                                             build every approved task with the script run
  environment show ID R                      each task's build and check
  environment build ID R                     build tasks approved since, or that failed
  environment delete ID R
  Run one with comparison create --environment ID.`,
  },
  {
    nouns: ["harness"],
    text: `Harnesses (the workspace's saved changes to an agent, which any comparison can run)
  harness list                               each one and what it changes
  harness create --name TEXT [--agent AGENT] [--skill ORG/REPO[@REF] ...]
      [--instructions TEXT | --instructions-file FILE] [--option AGENT.OPTION=VALUE|@FILE ...]
      [--subagent-model ID [--subagent-prompt TEXT | --subagent-prompt-file FILE]
       [--subagent-credential ID] [--subagent-thinking LEVEL]] | --body JSON|@FILE
  harness update ID (the same flags)         replace it; past runs keep what they ran
  harness show|delete ID
  catalog S --harness AGENT lists the options --option takes.`,
  },
  {
    nouns: ["catalog", "comparison", "evaluation"],
    text: `Evaluate (S is --repo, --custom, --public, or --group)
  catalog S                                  models an evaluation can use
  catalog S --harness AGENT                  options a saved harness can set on AGENT
  comparison create S --model ID [--model ID ...] [--harness AGENT ...] [--thinking LEVEL]
      [--credential ID] [--sandbox managed|e2b|modal|daytona] [--sandbox-credential ID]
      [--task TASK ...] [--skip-completed] [--judge-credential ID] [--saved-harness ID ...]
      [--environment ID ...] [--no-baseline] | --selection JSON|@FILE
                                             run each model on every approved task
  comparison list S | comparison show|resume|cancel ID S
  evaluation list S | evaluation show|cancel|delete ID S
                                             one model's run in a comparison, with its trials`,
  },
  {
    nouns: ["results", "summary", "task"],
    text: `Inspect (S is --repo, --custom, --public, or --group)
  results S                                  pass rate and cost per configuration
  task results TASK S                        every configuration on one task, with failure
                                             explanations and the fairness verdict
  task explain TASK S [--config KEY] [--model ID --credential ID] [--wait]
                                             explain why its failures failed
  task audit TASK S --model ID --credential ID [--wait]
                                             judge whether the task is fair
  summary show S                             the latest Model Summaries report
  summary create S --model ID --credential ID [--config KEY ...] [--wait]
                                             summarize how configurations differ`,
  },
  {
    nouns: ["release"],
    text: `Publish to selfbench.dev (public repositories, their groups, and Public Benchmarks)
  release preview S                          what a release would publish
  release publish S [--setting KEY ... | --all-settings] [--publish-tasks] [--publish-trials]
      [--publish-summaries]                  release the preview it just read
  release list S | release withdraw ID S`,
  },
  {
    nouns: ["operator"],
    text: `Operator (SELFBENCH_API_TOKEN, the deployment's own token)
  operator run list | operator run show|cancel RUN_ID
  operator run download RUN_ID OUT.tar.gz    a batch's Harbor export, checked against its SHA-256
  operator grant create --label TEXT --task ID [--task ID ...] [--days N] [--with-verifier]
  operator grant list | operator grant revoke GRANT_ID`,
  },
];

const DOCS = "Docs: https://docs.selfbench.dev/cli/overview";

/** Nouns that do nothing alone, so `self-bench NOUN` shows their help instead. */
const STANDALONE = new Set(["login", "logout", "whoami", "org", "catalog", "results"]);
export const ACTION_NOUNS = new Set(
  SECTIONS.flatMap((section) => section.nouns).filter((noun) => !STANDALONE.has(noun)),
);

/** Every command, or with `noun`, the sections that document it. */
export function printHelp(noun?: string): void {
  const chosen = noun ? SECTIONS.filter((section) => section.nouns.includes(noun)) : [];
  const texts = (chosen.length ? chosen : SECTIONS).map((section) => section.text);
  console.log([...(chosen.length ? [] : [INTRO]), ...texts, DOCS].join("\n\n"));
}
