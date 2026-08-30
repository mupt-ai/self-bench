import type { VercelCredentials } from "../../config.js";
import type { SetupPrompter } from "../../terminal-prompts.js";
import type { SetupReporter } from "../../terminal-reporter.js";
import type { VercelProject, VercelTeam } from "./cli.js";
import type { VercelCapability } from "./probe.js";
import type { VercelProfile, VercelProfileData } from "./profile.js";
import type { VercelRuntimeImageCli } from "./runtime-image.js";

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
  readonly saveProfile: (input: {
    readonly directory?: string;
    readonly profileName: string;
    readonly profile: VercelProfile;
    readonly token: string;
  }) => Promise<void>;
  readonly probe: (input: {
    readonly credentials: VercelCredentials;
    readonly image: string;
    readonly signal?: AbortSignal;
  }) => Promise<VercelCapability>;
  readonly sleep: (delayMs: number) => Promise<void>;
}
