import type { ThinkingLevel } from "../contracts/models.js";
import type { CredentialInfo } from "../db/credentials.js";
import type { Harness } from "../evaluation/models.js";
import type { EvaluationInput } from "../evaluation/types.js";

/**
 * What selfbench.dev reads, as the server writes it: the one definition of the public shapes,
 * which the site's `contract.ts` names for its pages. Aggregates only: nothing per task, no
 * credentials, no endpoint hosts, no people.
 */
export const RELEASE_SCHEMA_VERSION = 1;

/** The provider a run's model credential routes through. */
export type ReleaseProvider = NonNullable<EvaluationInput["credentials"]>["provider"];
/** API key or ChatGPT sign-in: the model credential's sign-in type. */
export type ReleaseSignIn = CredentialInfo["auth"];

/** A repository as GitHub identifies it. The id is the stable key across renames. */
export interface ReleaseRepository {
  id: number;
  fullName: string;
  /** Card metadata, as GitHub reported it when the release was written. */
  description?: string;
  language?: string;
  defaultBranch?: string;
  stars?: number;
  pushedAt?: string;
  ownerAvatarUrl?: string;
}

/** The workspace that ran and released the evals. Never the person who pressed Release. */
export interface ReleasePublisher {
  login: string;
  kind: "org" | "user";
  avatarUrl?: string;
}

/** One model configuration, scored over every task in the release. */
export interface ReleaseSetting {
  /** Opaque and stable within a release line; safe to use as a React key or URL fragment. */
  id: string;
  model: { catalogId: string; name: string; label: string };
  harness: Harness;
  reasoningLevel: ThinkingLevel;
  provider: ReleaseProvider;
  signIn: ReleaseSignIn;
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

/** What a release row stores in `payload`: everything public except the row's id and time. */
export interface ReleasePayload {
  schemaVersion: typeof RELEASE_SCHEMA_VERSION;
  repository: ReleaseRepository;
  publisher: ReleasePublisher;
  /** Number of tasks every setting was scored over. */
  tasks: number;
  settings: ReleaseSetting[];
  /** Setting ids on the accuracy-versus-cost Pareto frontier. */
  frontier: string[];
}

/** One release of one repository by one publisher, as served: the payload plus id and time. */
export interface PublishedRelease extends ReleasePayload {
  releaseId: string;
  releasedAt: string;
}

/** One release line's current release, as the public API lists it. */
export interface PublishedLine {
  release: PublishedRelease;
  /** Always false until maintainers can endorse a line. */
  endorsed: boolean;
}
