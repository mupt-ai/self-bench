/** What the worker asks a started sandbox job to do; written to the sandbox as JSON. */
export interface JobSpec {
  readonly command: readonly string[];
  /** Files uploaded when the command ends, each under its name; missing or empty ones skipped. */
  readonly outputs: readonly { name: string; path: string; contentType: string }[];
  /** Small JSON files returned inline with `done` instead of uploaded. */
  readonly inline?: readonly { name: string; path: string }[];
  /** The name the command's combined output is uploaded under. */
  readonly log: string;
  /** The command is killed and the attempt failed after this long without any output. */
  readonly inactivityMs?: number;
  /**
   * Sets of files that each count as a delivered result. Without one, a failed command, a
   * provider error, or a missing session fails the attempt so Temporal retries it; with
   * `requireDelivery`, so does a clean exit.
   */
  readonly delivers?: readonly (readonly string[])[];
  readonly requireDelivery?: boolean;
  /** A Pi agent: its live feed, token usage, and session summary are reported too. */
  readonly agent?: {
    /** Folder the redacted live-feed snapshots are uploaded to. */
    readonly live: string;
    /** Environment variables whose values never reach the feed. */
    readonly redact: readonly string[];
    /** The session file the last message and any provider error are read from. */
    readonly session: string;
  };
}

export const JOB_SPEC_FILE = ".selfbench-job.json";

/** When the command is killed so the job can still report before its sandbox expires. */
export const JOB_DEADLINE_VARIABLE = "SELFBENCH_JOB_DEADLINE";
