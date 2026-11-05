export function printHelp(): void {
  console.log(`SelfBench command-line access to the API.

Usage:
  self-bench status RUN_ID
  self-bench cancel RUN_ID
  self-bench list
  self-bench download RUN_ID OUTPUT.tar.gz
  self-bench grant create --label NAME --task ID [--task ID ...] [--days N] [--with-verifier]
  self-bench grant list
  self-bench grant revoke GRANT_ID

  self-bench scenario create --repo OWNER/NAME --title TITLE
      (--scenario TEXT | --scenario-file FILE) [--commit SHA|BRANCH] [--attach FILE ...]
      [--difficulty easy|medium|hard]
  self-bench tasks --repo OWNER/NAME
  self-bench task show RUN_ID TASK_ID --repo OWNER/NAME
  self-bench task pull RUN_ID TASK_ID [DIRECTORY] --repo OWNER/NAME
  self-bench task revise RUN_ID TASK_ID --repo OWNER/NAME
      (--feedback TEXT | --feedback-file FILE) [--draft DIRECTORY]
  self-bench task approve|reject RUN_ID TASK_ID --repo OWNER/NAME [--note TEXT]
  self-bench task unreview|cancel|delete RUN_ID TASK_ID --repo OWNER/NAME

Commands call SELFBENCH_API_URL (default http://127.0.0.1:8080).

scenario and task act as the owner of a personal API key: create one under API Keys, then set
SELFBENCH_API_KEY (a write key, except for tasks and task show|pull). --org names the workspace
when it isn't the repository's owner. scenario create and task revise start a generation, set by
--model, --verifier-model, --reasoning, --model-credential, --sandbox, --sandbox-credential,
--harbor, and --harbor-credential (by default managed models and sandbox, as in the app), or by
--generation with the settings as JSON or @FILE.

scenario create --commit starts the agent from the repository at that commit (a branch resolves to
its head); the author writes the change's reference implementation and hidden tests against it.
Without --commit, the author writes the files the agent starts with.

task pull writes the task's files (instruction.md, Dockerfile, the patches, scripts, and a
scenario's workspace/) into DIRECTORY. task revise starts a revision from the task's last draft,
or from DIRECTORY with --draft, and its agent addresses the feedback, keeps your edits, and
verifies the result. The original task and its evaluations stay as they are.

status, cancel, list, download, and grant use SELFBENCH_API_TOKEN, the operator's token.
download verifies the export's SHA-256 before keeping the file. grant issues a customer a
registry login for accepted tasks' images (agent images only unless --with-verifier, since the
verifier images hold the tests). It prints the password once, and expires after --days
(default 30). revoke takes effect on the next pull.`);
}
