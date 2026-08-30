import type { SetupPrompter } from "../../terminal-prompts.js";
import type { VercelProject, VercelTeam } from "./cli.js";
import type { VercelProfile } from "./profile.js";
import type { VercelSetupCli, VercelSetupServices } from "./setup-types.js";

const DEFAULT_PROJECT_NAME = "selfbench-sandbox";

export type SetupAction = "revalidate" | "replace-token" | "change-project";

export async function chooseSetupAction(
  prompter: SetupPrompter,
  profile: VercelProfile | undefined,
  token: string | undefined,
): Promise<SetupAction> {
  if (!profile) {
    return "change-project";
  }
  const choices = [
    ...(token
      ? [
          {
            value: "revalidate",
            label: `Revalidate ${profile.teamSlug}/${profile.projectName}`,
            hint: "Recommended",
          },
        ]
      : []),
    { value: "replace-token", label: "Replace the access token" },
    { value: "change-project", label: "Choose another team or project" },
  ];
  const selected = await prompter.select(
    `Vercel profile is already configured for ${profile.teamSlug}/${profile.projectName}`,
    choices,
    token ? "revalidate" : "replace-token",
  );
  if (selected !== "revalidate" && selected !== "replace-token" && selected !== "change-project") {
    throw new Error(`Unsupported Vercel setup action: ${selected}`);
  }
  return selected;
}

export async function chooseTeam(
  prompter: SetupPrompter,
  teams: readonly VercelTeam[],
): Promise<VercelTeam> {
  const selectedId = await prompter.search(
    "Choose a Vercel team or personal scope",
    teams.map((team) => ({
      value: team.id,
      label: team.name,
      hint: [
        team.slug,
        team.id.startsWith("team_") ? undefined : "personal scope",
        team.current ? "current" : undefined,
      ]
        .filter(Boolean)
        .join(" · "),
    })),
    teams.find(({ current }) => current)?.id,
  );
  return teams.find(({ id }) => id === selectedId) ?? fail("selected Vercel team disappeared");
}

export async function chooseProject(
  services: VercelSetupServices,
  team: VercelTeam,
): Promise<{ readonly project: VercelProject; readonly created: boolean }> {
  let projects = await services.cli.listProjects(team.slug);
  const modes = [
    ...(projects.length > 0 ? [{ value: "existing", label: "Select an existing project" }] : []),
    { value: "create", label: "Create a dedicated project", hint: "Recommended" },
  ];
  const mode = await services.prompter.select(
    "Choose how to configure the Vercel project",
    modes,
    "create",
  );
  if (mode === "existing") {
    const projectId = await services.prompter.search(
      "Choose an existing project",
      projects.map((project) => ({
        value: project.id,
        label: project.name,
        hint: project.id,
      })),
    );
    return {
      project:
        projects.find(({ id }) => id === projectId) ?? fail("selected Vercel project disappeared"),
      created: false,
    };
  }

  for (;;) {
    const name = (await services.prompter.text("New project name", DEFAULT_PROJECT_NAME)).trim();
    if (!isValidProjectName(name)) {
      services.reporter.warn(
        "Project names must use 1-100 lowercase letters, digits, dots, underscores, or hyphens and cannot contain three consecutive hyphens.",
      );
      continue;
    }
    if (projects.some((project) => project.name.toLowerCase() === name.toLowerCase())) {
      services.reporter.warn(`Project name "${name}" is already in use. Choose another name.`);
      continue;
    }
    try {
      return { project: await services.cli.createProject(team.slug, name), created: true };
    } catch (error) {
      projects = await services.cli.listProjects(team.slug);
      if (projects.some((project) => project.name.toLowerCase() === name.toLowerCase())) {
        services.reporter.warn(`Project name "${name}" became unavailable. Choose another name.`);
        continue;
      }
      throw new Error(`Unable to create project "${name}": ${errorMessage(error)}`, {
        cause: error,
      });
    }
  }
}

export async function resolveExistingSelection(
  cli: VercelSetupCli,
  teams: readonly VercelTeam[],
  profile: VercelProfile,
): Promise<SelectedProject> {
  const team = teams.find(({ id }) => id === profile.teamId);
  if (!team) {
    throw new Error(
      `Saved Vercel team ${profile.teamSlug} is no longer accessible; rerun setup and choose another team`,
    );
  }
  const project = (await cli.listProjects(team.slug)).find(({ id }) => id === profile.projectId);
  if (!project) {
    throw new Error(
      `Saved Vercel project ${profile.projectName} is no longer accessible; rerun setup and choose another project`,
    );
  }
  return { team, project };
}

export async function requestProjectToken(
  services: VercelSetupServices,
  selected: SelectedProject,
): Promise<string> {
  services.reporter.message("");
  services.reporter.message(
    `Create a Vercel access token for team ${selected.team.name} and restrict it to project ${selected.project.name}:`,
  );
  services.reporter.message("https://vercel.com/account/settings/tokens");
  services.reporter.message('A descriptive token name such as "selfbench-local" is recommended.');
  const token = (await services.prompter.secret("Paste the project-scoped access token")).trim();
  if (!token) {
    throw new Error("Vercel access token must not be blank");
  }
  return token;
}

export interface SelectedProject {
  readonly team: VercelTeam;
  readonly project: VercelProject;
}

function isValidProjectName(value: string): boolean {
  return /^[a-z0-9._-]{1,100}$/.test(value) && !value.includes("---");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fail(message: string): never {
  throw new Error(message);
}
