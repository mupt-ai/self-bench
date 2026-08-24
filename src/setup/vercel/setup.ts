import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { VercelCredentials } from "../../config.js";
import {
  isInteractiveTerminal,
  SetupCanceledError,
  type SetupPrompter,
  TerminalPrompter,
} from "../../terminal-prompts.js";
import { type SetupReporter, TerminalSetupReporter } from "../../terminal-reporter.js";
import { VercelCli, type VercelProject, type VercelTeam } from "./cli.js";
import { probeVercelCapability, type VercelCapability } from "./probe.js";
import {
  loadVercelProfileData,
  saveVercelProfile,
  selfBenchConfigDirectory,
  type VercelProfile,
  type VercelProfileData,
  validateVercelProfileName,
} from "./profile.js";
import {
  DEFAULT_VCR_REPOSITORY,
  ensureVercelRuntimeImage,
  type VercelRuntimeImageCli,
  vercelRuntimeFingerprint,
} from "./runtime-image.js";

const DEFAULT_PROFILE_NAME = "default";
const DEFAULT_PROJECT_NAME = "selfbench-sandbox";

export interface VercelSetupCli extends VercelRuntimeImageCli {
  ensureAvailable(): Promise<void>;
  ensureLoggedIn(): Promise<void>;
  listTeams(): Promise<readonly VercelTeam[]>;
  listProjects(teamSlug: string): Promise<readonly VercelProject[]>;
  createProject(teamSlug: string, projectName: string): Promise<VercelProject>;
}

export interface VercelSetupServices {
  readonly cli: VercelSetupCli;
  readonly prompter: SetupPrompter;
  readonly reporter: SetupReporter;
  readonly interactive: boolean;
  readonly loadProfiles: (directory: string) => Promise<VercelProfileData>;
  readonly saveProfile: typeof saveVercelProfile;
  readonly probe: (input: {
    readonly credentials: VercelCredentials;
    readonly image: string;
    readonly signal?: AbortSignal;
  }) => Promise<VercelCapability>;
  readonly sleep: (delayMs: number) => Promise<void>;
}

export interface VercelSetupResult {
  readonly profileName: string;
  readonly profile: VercelProfile;
  readonly configDirectory: string;
  readonly projectCreated: boolean;
  readonly imagePublished: boolean;
}

export async function setupVercel(
  options: {
    readonly profileName?: string;
    readonly environment?: NodeJS.ProcessEnv;
    readonly projectRoot?: string;
    readonly verbose?: boolean;
  } = {},
  providedServices?: VercelSetupServices,
): Promise<VercelSetupResult> {
  const services = providedServices ?? defaultServices(options.verbose ?? false);
  if (!services.interactive) {
    throw new Error(
      "self-bench setup vercel requires an interactive terminal; unattended environments should set VERCEL_TOKEN, VERCEL_TEAM_ID, VERCEL_PROJECT_ID, SELFBENCH_VERCEL_IMAGE, and optionally SELFBENCH_VERCEL_TIMEOUT_CAP",
    );
  }
  services.reporter.intro("Configure Vercel Sandbox");
  const profileName = validateVercelProfileName(options.profileName ?? DEFAULT_PROFILE_NAME);
  const environment = options.environment ?? process.env;
  const configDirectory = selfBenchConfigDirectory(environment);
  const projectRoot = resolve(options.projectRoot ?? defaultProjectRoot());
  const existingData = await services.loadProfiles(configDirectory);
  const existingProfile = existingData.profiles[profileName];
  const existingToken = existingData.tokens[profileName];
  const action = await chooseSetupAction(services.prompter, existingProfile, existingToken);

  await services.cli.ensureAvailable();
  await services.cli.ensureLoggedIn();

  const teams = await services.cli.listTeams();
  if (teams.length === 0) {
    throw new Error("The Vercel account has no accessible team or personal scope");
  }
  let selected: SelectedProject;
  let projectCreated = false;
  if (action === "change-project" || !existingProfile) {
    const team = await chooseTeam(services.prompter, teams);
    const projectSelection = await chooseProject(services, team);
    selected = { team, project: projectSelection.project };
    projectCreated = projectSelection.created;
  } else {
    selected = await resolveExistingSelection(services.cli, teams, existingProfile);
  }

  const fingerprint = await vercelRuntimeFingerprint(projectRoot);
  const imageResult = await ensureVercelRuntimeImage({
    services: {
      cli: services.cli,
      prompter: services.prompter,
      reporter: services.reporter,
      sleep: services.sleep,
    },
    scope: { teamSlug: selected.team.slug, projectId: selected.project.id },
    projectRoot,
    fingerprint,
    preferredRepository:
      action === "change-project" || !existingProfile
        ? DEFAULT_VCR_REPOSITORY
        : existingProfile.vcrRepository,
  });

  const token =
    action === "revalidate" && existingToken
      ? existingToken
      : await requestProjectToken(services, selected);
  const credentials = {
    token,
    teamId: selected.team.id,
    projectId: selected.project.id,
  };
  const controller = new AbortController();
  const interrupt = (): void => controller.abort(new SetupCanceledError());
  process.once("SIGINT", interrupt);
  let capability: VercelCapability;
  try {
    capability = await services.reporter.task(
      {
        pending: "Verifying Sandbox access and detecting the timeout cap",
        success: "Sandbox access verified",
        failure: "Sandbox verification failed",
      },
      async () => {
        try {
          return await services.probe({
            credentials,
            image: imageResult.image,
            signal: controller.signal,
          });
        } catch (error) {
          if (controller.signal.aborted) {
            throw controller.signal.reason;
          }
          throw error;
        }
      },
    );
  } catch (error) {
    if (controller.signal.aborted) {
      throw controller.signal.reason;
    }
    throw new Error(
      `Vercel Sandbox verification failed: ${errorMessage(error)}. If the access token expired or has the wrong project scope, rerun setup and paste a new project-scoped token; choose Replace the access token when revalidating an existing profile.`,
      { cause: error },
    );
  } finally {
    process.removeListener("SIGINT", interrupt);
  }

  if (capability.timeoutClass === "45m") {
    services.reporter.warn(
      "This Vercel scope enforces a 45-minute Sandbox limit. SelfBench will cap longer authoring and repair stages at 45 minutes; accepted tasks remain fully validated, but slow candidates may time out and be rejected.",
    );
    services.reporter.warn(
      "Vercel Hobby usage is intended for personal, non-commercial work. Use a paid team for commercial SelfBench runs.",
    );
    if (
      !(await services.prompter.confirm("Continue with the 45-minute compatibility cap?", true))
    ) {
      services.reporter.cancel("Vercel setup canceled before profile activation.");
      throw new SetupCanceledError("Vercel setup canceled before profile activation");
    }
  }

  const profile: VercelProfile = {
    teamId: selected.team.id,
    teamSlug: selected.team.slug,
    teamName: selected.team.name,
    projectId: selected.project.id,
    projectName: selected.project.name,
    vcrRepository: imageResult.repository,
    image: imageResult.image,
    runtimeFingerprint: fingerprint,
    timeoutCapMs: capability.timeoutCapMs,
    capabilityCheckedAt: capability.checkedAt,
  };
  await services.saveProfile({ directory: configDirectory, profileName, profile, token });
  services.reporter.finish(`Saved Vercel profile "${profileName}"`, [
    `Location: ${configDirectory}`,
    `Project: ${profile.teamSlug}/${profile.projectName}`,
    `Runtime image: ${imageRepository(profile.image)}`,
    "Digest:",
    `  ${imageDigest(profile.image)}`,
    `Vercel tier: ${timeoutTier(capability.timeoutClass)}`,
    `Timeout cap: ${formatDuration(profile.timeoutCapMs)}`,
    "Resources: Project and runtime image remain reusable after self-bench down.",
  ]);

  return {
    profileName,
    profile,
    configDirectory,
    projectCreated,
    imagePublished: imageResult.published,
  };
}

function defaultServices(verbose: boolean): VercelSetupServices {
  const reporter = new TerminalSetupReporter({ verbose });
  return {
    cli: new VercelCli(),
    prompter: new TerminalPrompter(),
    reporter,
    interactive: isInteractiveTerminal(),
    loadProfiles: loadVercelProfileData,
    saveProfile: saveVercelProfile,
    probe: probeVercelCapability,
    sleep: async (delayMs) => await delay(delayMs),
  };
}

type SetupAction = "revalidate" | "replace-token" | "change-project";

async function chooseSetupAction(
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

async function chooseTeam(
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

async function chooseProject(
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

async function resolveExistingSelection(
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

async function requestProjectToken(
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

function isValidProjectName(value: string): boolean {
  return /^[a-z0-9._-]{1,100}$/.test(value) && !value.includes("---");
}

function formatDuration(timeoutMs: number): string {
  return timeoutMs % (60 * 60 * 1_000) === 0
    ? `${timeoutMs / (60 * 60 * 1_000)}h`
    : `${timeoutMs / (60 * 1_000)}m`;
}

function timeoutTier(timeoutClass: VercelCapability["timeoutClass"]): string {
  return timeoutClass === "45m" ? "Hobby-compatible" : "Pro/Enterprise-compatible";
}

function imageRepository(image: string): string {
  return image.slice(0, image.lastIndexOf("@"));
}

function imageDigest(image: string): string {
  return image.slice(image.lastIndexOf("@") + 1);
}

function defaultProjectRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fail(message: string): never {
  throw new Error(message);
}

interface SelectedProject {
  readonly team: VercelTeam;
  readonly project: VercelProject;
}
