/** Help for the Benchmarks commands. */

import { type Group, R, WRITER_FLAGS } from "./help-spec.js";

export const BENCHMARKS: Group = {
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
          long: "A Bash script run in every approved task's image. Run one with\n`run create --environment ID`.",
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
};
