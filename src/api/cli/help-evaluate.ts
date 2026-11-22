/** Help for the Tasks and Evaluate commands. */

import { B, type Group, S, WAIT, WRITER_FLAGS } from "./help-spec.js";

export const TASKS: Group = {
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
};

export const EVALUATE: Group = {
  title: "Evaluate",
  nouns: [
    {
      name: "run",
      summary: "Run models on a benchmark's approved tasks; one run per model",
      verbs: [
        {
          name: "create",
          args: `${S} --model ID [--model ID ...]`,
          summary: "Run each model on every approved task, as one batch",
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
        { name: "list", args: S, summary: "List runs" },
        { name: "show", args: `ID ${S}`, summary: "Show a run and its trials" },
        { name: "cancel", args: `ID ${S}`, summary: "Cancel a run" },
        { name: "delete", args: `ID ${S}`, summary: "Delete a run" },
        {
          name: "models",
          args: S,
          summary: "List models a run can use",
          flags: [["--harness AGENT", "list the options a saved harness can set on AGENT"]],
        },
      ],
      nouns: [
        {
          name: "batch",
          summary: "Runs started together by one `run create`",
          verbs: [
            { name: "list", args: S, summary: "List batches" },
            { name: "show", args: `ID ${S}`, summary: "Show a batch's runs" },
            { name: "resume", args: `ID ${S}`, summary: "Start a batch's runs that did not start" },
            { name: "cancel", args: `ID ${S}`, summary: "Cancel a batch's runs" },
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
};
