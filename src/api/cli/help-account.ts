/** Help for the account, workspace, and operator commands. */

import type { Group, Noun } from "./help-spec.js";

export const GET_STARTED: Group = {
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
};

export const WORKSPACE: Group = {
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
};

export const OPERATOR: Noun = {
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
