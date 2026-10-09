import type { ThinkingLevel } from "../contracts/models.js";
import type { CredentialInfo } from "../db/credentials.js";
import type { TaskRecord } from "../db/tasks.js";
import type { Harness } from "../evaluation/models.js";
import type { EvaluationInput, EvaluationTrial } from "../evaluation/types.js";

/**
 * What selfbench.dev reads, as the server writes it: the one definition of the public shapes,
 * which the site's `contract.ts` names for its pages. Aggregates, plus each task's files when
 * the publisher chose to publish them, and each setting's result and transcript on each task
 * when they chose that too; never credentials, endpoint hosts, Harbor logs beyond the verifier's
 * test output, or people.
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
  /**
   * Unique within a release: model, harness, and reasoning level. Safe as a React key or URL fragment.
   */
  id: string;
  model: { catalogId: string; name: string; label: string };
  harness: Harness;
  reasoningLevel: ThinkingLevel;
  /** Model vendor (or custom), not the route used for any one task. */
  provider: ReleaseProvider;
  /** Legacy releases had a single sign-in type. Combined releases omit this field. */
  signIn?: ReleaseSignIn;
  /** True for a custom model; endpoint hosts are not public. */
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
  /** Set when the publisher chose to publish the tasks, for anyone to browse and download. */
  tasksPublished?: true;
  /**
   * Set when the publisher also chose to publish each setting's result on each task, with its
   * transcript. Only ever set with `tasksPublished`, since the results name the tasks.
   */
  trialsPublished?: true;
}

/** One release of one repository by one publisher, as served: the payload plus id and time. */
export interface PublishedRelease extends ReleasePayload {
  releaseId: string;
  releasedAt: string;
}

/** One task of a release that published its tasks, as selfbench.dev lists it. */
export interface PublishedTask {
  /** The task's id, unique within the release and safe in an address (numbered if two match). */
  id: string;
  difficulty: TaskRecord["difficulty"];
  /** The merged pull request the task was built from. */
  sourcePr?: number;
  sourceUrl?: string;
  /**
   * Whether each setting passed it, by setting id; only on a release that published its trials.
   * Every setting of a release has a result on every one of its tasks.
   */
  passed?: Record<string, boolean>;
}

/**
 * One setting's trial on one published task: its result, how the verifier graded it, what it
 * cost, and the solver's transcript, with secrets redacted. Of Harbor's log only the verifier's
 * test output; never the rest of it, the artifacts, or the error, which can name endpoint hosts
 * and sandbox details.
 */
export interface PublishedTrial
  extends Pick<
    EvaluationTrial,
    | "startedAt"
    | "finishedAt"
    | "agentTimedOut"
    | "apiCostUsd"
    | "costSource"
    | "tokenUsage"
    | "cacheWritesInferred"
    | "steps"
    | "rewards"
  > {
  taskId: string;
  settingId: string;
  passed: boolean;
  /** The agent's time limit on the run, in minutes. */
  agentMinutes?: number;
  /** What the verifier's tests printed (the task's tests/test.sh), when the trial kept it. */
  verifierOutput?: string;
}

/** A published task's files: small text files with their contents, the rest by size alone. */
export interface PublishedTaskFiles {
  taskId: string;
  files: readonly { path: string; sizeBytes: number; text?: string }[];
}

/** One release line's current release, as the public API lists it. */
export interface PublishedLine {
  release: PublishedRelease;
  /** Always false until maintainers can endorse a line. */
  endorsed: boolean;
}
