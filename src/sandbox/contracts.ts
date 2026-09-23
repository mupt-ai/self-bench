interface InlineSandboxFile {
  readonly path: string;
  readonly contents: Uint8Array | string;
}

/**
 * A file the sandbox fetches itself from a URL (a signed artifact URL) and verifies by SHA-256,
 * so the worker never buffers or uploads large bundles: E2B's client-side request timeout made
 * concurrent 300 MB `files.write` calls fail, and E2B recommends pulling from a URL in-sandbox.
 */
export interface RemoteSandboxFile {
  readonly path: string;
  readonly url: string;
  readonly sha256: string;
}

export type SandboxFile = InlineSandboxFile | RemoteSandboxFile;

export function isRemoteSandboxFile(file: SandboxFile): file is RemoteSandboxFile {
  return "url" in file;
}

export interface SandboxRequest {
  readonly runId: string;
  readonly stage: string;
  readonly command: readonly string[];
  readonly files?: readonly SandboxFile[];
  /** Required after exit zero; best-effort diagnostic outputs after nonzero/failure. */
  readonly outputPaths?: readonly string[];
  readonly environment?: Readonly<Record<string, string>>;
  readonly secrets?: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly inactivityTimeoutMs?: number;
  readonly cpu?: number;
  readonly memoryMiB?: number;
}

/** Provider/accounting-backed cost observed while one sandbox request is running. */
export interface SandboxCostSnapshot {
  readonly stage: string;
  readonly state: "estimated" | "partial" | "unpriced" | "unknown";
  readonly sandboxSeconds: number;
  readonly sandboxUsd?: number;
  readonly modelUsd?: number;
  readonly updatedAt: string;
}

export interface SandboxRunOptions {
  readonly signal?: AbortSignal;
  readonly onOutput?: (stream: "stdout" | "stderr", chunk: Uint8Array) => void;
  readonly onCost?: (cost: SandboxCostSnapshot) => void;
}

export interface SandboxResult {
  readonly sandboxId: string;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly outputs: Readonly<Record<string, Uint8Array>>;
}

export class SandboxExecutionError extends Error {
  constructor(
    message: string,
    readonly result: SandboxResult,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SandboxExecutionError";
  }
}

/**
 * Runs one command in a fresh sandbox and deletes the sandbox afterwards. Declared outputs are
 * required after exit 0 and best-effort otherwise; a hard deadline returns exit code 124.
 */
export interface SandboxExecutor {
  run(request: SandboxRequest, options?: SandboxRunOptions): Promise<SandboxResult>;
  close(): void;
}
