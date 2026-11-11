export function printHelp(): void {
  console.log(`self-bench: build, review, run, and publish evals from the terminal.

Setup
  self-bench login                   sign in through your browser; saves a key and workspace
  self-bench org [use [NAME]]        show or change the workspace commands use
  self-bench whoami                  the signed-in account, workspaces, and key scope
  self-bench logout                  revoke the saved key and forget it

  In CI, set SELFBENCH_API_KEY (Settings → API Keys) instead of logging in. SELFBENCH_ORG and
  --org override the workspace; SELFBENCH_API_URL or login --api-url point at another deployment.

Credentials (workspace admins)
  self-bench credentials                             saved keys and sign-ins, with their IDs
  self-bench credential add                          pick a provider, then paste a key or sign in
  self-bench credential add --kind KIND (--value-env VAR | --value-stdin) [--name NAME]
      [--token-id ID] [--team-id ID --project-id ID] [--endpoint URL]
  self-bench credential add --sign-in chatgpt|claude|meta [--name NAME]
  self-bench credential rename ID NAME | credential remove ID

Build
  self-bench repos                                   connected repositories and evals
  self-bench repo connect|show|disconnect OWNER/NAME
  self-bench repo set OWNER/NAME --agent-minutes N  how long agents get per task
  self-bench eval create NAME                        a workspace eval (then --repo evals/NAME)
  self-bench prs --repo R [--page N]                 merged pull requests
  self-bench generate --repo R --easy N --medium N --hard N [--focus TEXT]
  self-bench task add-pr --repo R --pr NUMBER|URL
  self-bench scenario create --repo R --title TITLE (--scenario TEXT | --scenario-file FILE)
      [--commit SHA|BRANCH] [--attach FILE ...] [--difficulty easy|medium|hard]
  self-bench batches --repo R | batch show|cancel RUN_ID --repo R

  generate, task add-pr, scenario create, and task revise take --model, --verifier-model,
  --reasoning, --model-credential, --sandbox, --sandbox-credential, --harbor,
  --harbor-credential, or --generation JSON|@FILE (default: managed models and sandbox).

Review
  self-bench tasks --repo R [--state needs_review|accepted|rejected|in_progress|failed]
  self-bench task show|pull RUN_ID TASK_ID [DIR] --repo R
  self-bench task approve|reject RUN_ID TASK_ID --repo R [--note TEXT]
  self-bench task revise RUN_ID TASK_ID --repo R (--feedback TEXT | --feedback-file FILE)
      [--draft DIR]
  self-bench task steer RUN_ID TASK_ID --repo R (--feedback TEXT | --feedback-file FILE)
                                                     note for a task still generating; its
                                                     author reads it at its next turn
  self-bench task steering RUN_ID TASK_ID --repo R   notes sent, and which turn received each
  self-bench task unreview|cancel|delete RUN_ID TASK_ID --repo R

Environments (changes to every approved task's files, each task built and checked once)
  self-bench environments --repo R                   each one and how many tasks are ready
  self-bench environment create --repo R --name N [--package NAME@SPEC ...] [--directory DIR]
      [--file DEST=SOURCE ...] [--replace] [--delete PATH ...] | --environment JSON|@FILE
  self-bench environment show|build|delete ID --repo R
                                                     build: tasks approved since, or that failed
  Run one with compare --condition '{"name":"No AGENTS.md","environment":ID}'.

Evaluate
  self-bench catalog --repo R                        models evaluations can use
  self-bench compare --repo R --model ID [--model ID ...] [--harness pi|codex|claude-code|...]
      [--thinking LEVEL] [--credential ID] [--sandbox managed|e2b|modal|daytona]
      [--sandbox-credential ID] [--task RUN_ID/TASK_ID ...] [--skip-completed]
      [--judge-credential ID] [--condition JSON|@FILE ...] [--no-baseline]
      | --selection JSON|@FILE
      a condition runs every task again with skills or instructions:
      '{"name":"With Skills","skills":["org/repo"],"instructions":"..."}' 
  self-bench comparisons --repo R | comparison show|resume|cancel ID --repo R
  self-bench runs --repo R | run show|cancel|delete EVALUATION_ID --repo R

Inspect
  self-bench results --repo R                        pass rate and cost per configuration
  self-bench task results RUN_ID TASK_ID --repo R    every configuration on one task, with
                                                     failure explanations and fairness
  self-bench task explain RUN_ID TASK_ID --repo R [--config KEY] [--model M --credential ID]
      [--wait]                                       explain why its failures failed
  self-bench task audit RUN_ID TASK_ID --repo R --model M --credential ID [--wait]
                                                     judge whether the task is fair
  self-bench summaries --repo R                      the latest Model Summaries report
  self-bench summaries create --repo R --model M --credential ID [--config KEY ...] [--wait]

Publish (public repositories, to selfbench.dev)
  self-bench release preview --repo R                what a release would publish
  self-bench release publish --repo R [--setting KEY ... | --all-settings]
      [--publish-tasks] [--publish-trials] [--publish-summaries]
  self-bench releases --repo R | release withdraw RELEASE_ID --repo R

Benchmarks and groups
  self-bench benchmarks | benchmark add|show|tasks|remove ORG/NAME[@REF]   Harbor datasets
  self-bench groups | group show|delete SLUG
  self-bench group create|update SLUG --name NAME --member OWNER/NAME [--member ...]
  Evaluate, Inspect, and release commands take --benchmark ORG/NAME or --group SLUG for --repo
  (benchmarks are never released).

Every command takes --org and --json. Lists print tables on a terminal and JSON when piped.

Operator (SELFBENCH_API_TOKEN, the deployment's token)
  self-bench status|cancel RUN_ID | list | download RUN_ID OUT.tar.gz
  self-bench grant create --label NAME --task ID [--task ID ...] [--days N] [--with-verifier]
  self-bench grant list | grant revoke GRANT_ID

Docs: https://docs.selfbench.dev/cli/overview`);
}
