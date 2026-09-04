export interface InlineSandboxFile {
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
  readonly outputPaths?: readonly string[];
  readonly environment?: Readonly<Record<string, string>>;
  readonly secrets?: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly inactivityTimeoutMs?: number;
  readonly cpu?: number;
  readonly memoryMiB?: number;
}

export interface SandboxProgress {
  readonly stream: "stdout" | "stderr";
  readonly bytes: number;
}

export interface SandboxExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** A sandbox whose main command is still running; used for the worker↔agent mailbox. */
export interface LiveSandbox {
  readonly sandboxId: string;
  execute(command: readonly string[]): Promise<SandboxExecResult>;
  /** Resolves undefined when the file does not exist. */
  readFile(path: string): Promise<Uint8Array | undefined>;
  writeFile(path: string, contents: Uint8Array | string): Promise<void>;
}

export interface SandboxRunOptions {
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: SandboxProgress) => void;
  /**
   * Runs concurrently with the main command once it has started; `exited` aborts when the command
   * finishes. run() waits for it to settle before collecting outputs and rejects if it throws.
   */
  readonly onLive?: (sandbox: LiveSandbox, exited: AbortSignal) => Promise<void>;
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

export interface SandboxExecutor {
  run(request: SandboxRequest, options?: SandboxRunOptions): Promise<SandboxResult>;
  /** The following act on a sandbox whose run() is in progress. */
  execute(sandboxId: string, command: readonly string[]): Promise<SandboxExecResult>;
  readFile(sandboxId: string, path: string): Promise<Uint8Array | undefined>;
  writeFile(sandboxId: string, path: string, contents: Uint8Array | string): Promise<void>;
  close(): void;
}
