import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  isInteractiveTerminal,
  SetupCanceledError,
  TerminalPrompter,
} from "../../terminal-prompts.js";
import { TerminalSetupReporter } from "../../terminal-reporter.js";
import { VercelCli } from "./cli.js";
import { probeVercelCapability, type VercelCapability } from "./probe.js";
import {
  loadVercelProfileData,
  saveVercelProfile,
  selfBenchConfigDirectory,
  type VercelProfile,
  validateVercelProfileName,
} from "./profile.js";
import {
  DEFAULT_VCR_REPOSITORY,
  ensureVercelRuntimeImage,
  vercelRuntimeFingerprint,
} from "./runtime-image.js";
import type { VercelSetupServices } from "./setup-types.js";

export type { VercelSetupCli, VercelSetupServices } from "./setup-types.js";

import {
  chooseProject,
  chooseSetupAction,
  chooseTeam,
  requestProjectToken,
  resolveExistingSelection,
  type SelectedProject,
} from "./selection.js";

const DEFAULT_PROFILE_NAME = "default";

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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function defaultProjectRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
}
