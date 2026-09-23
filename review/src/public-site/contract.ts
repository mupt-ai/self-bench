import type { ThinkingLevel } from "../../../src/contracts/models";
import type { Harness } from "../../../src/evaluation/models";

/**
 * The public data contract: what selfbench.dev pages consume. Aggregates only. Nothing per
 * task, no credentials, no transcripts. Produced later by the release builder; today by
 * fixtures behind `PublicSource`.
 */
export const PUBLIC_SCHEMA_VERSION = 1;

type PublicProvider = "openai" | "anthropic" | "openrouter" | "custom";
type PublicSignIn = "api-key" | "codex-login";

/** A repository as GitHub identifies it. The id is the stable key across renames. */
interface PublicRepository {
  id: number;
  fullName: string;
  /** Card metadata, refreshed independently of results. */
  description?: string;
  language?: string;
  defaultBranch?: string;
  stars?: number;
  pushedAt?: string;
  ownerAvatarUrl?: string;
}

/** The workspace that ran and released the evals. Never the person who pressed Release. */
interface PublicPublisher {
  login: string;
  kind: "org" | "user";
  avatarUrl?: string;
}

/** One model configuration, scored over every task in the release. */
export interface PublicSetting {
  /** Opaque and stable within a release line; safe to use as a React key or URL fragment. */
  id: string;
  model: { catalogId: string; name: string; label: string };
  harness: Harness;
  reasoningLevel: ThinkingLevel;
  provider: PublicProvider;
  signIn: PublicSignIn;
  /** True for a custom OpenAI-compatible endpoint; the host is not public. */
  custom: boolean;
  tasks: number;
  passed: number;
  /** Percentage, 0 to 100. */
  accuracy: number;
  costPerTaskUsd: number;
  totalCostUsd: number;
  onFrontier: boolean;
}

/** One release of one repository by one publisher: the unit a repository page shows. */
export interface PublicRelease {
  schemaVersion: typeof PUBLIC_SCHEMA_VERSION;
  releaseId: string;
  releasedAt: string;
  repository: PublicRepository;
  publisher: PublicPublisher;
  /** Number of tasks every setting was scored over. */
  tasks: number;
  settings: PublicSetting[];
  /** Setting ids on the accuracy-versus-cost Pareto frontier. */
  frontier: string[];
}

/** One release line of a repository, for the switcher and search results. */
interface PublicLineSummary {
  publisher: PublicPublisher;
  releaseId: string;
  releasedAt: string;
  tasks: number;
  settings: number;
  endorsed: boolean;
}

/** What a repository page needs: the shown release plus every line the repository has. */
export interface PublicRepoPage {
  release: PublicRelease;
  endorsed: boolean;
  lines: PublicLineSummary[];
}

type PickRole = "cheapest" | "mostAccurate";

/** A frontier setting singled out on cards and the picks strip, with every role it holds. */
export interface PublicPick {
  setting: PublicSetting;
  roles: PickRole[];
}

/** One entry of the home page directory: the default line's release, reduced to a card. */
export interface PublicRepoSummary {
  repository: PublicRepository;
  publisher: PublicPublisher;
  releaseId: string;
  releasedAt: string;
  tasks: number;
  settings: number;
  picks: PublicPick[];
  frontier: Pick<PublicSetting, "id" | "model" | "accuracy" | "costPerTaskUsd">[];
  endorsed: boolean;
}
