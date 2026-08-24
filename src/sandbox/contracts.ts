export interface SandboxFile {
  readonly path: string;
  readonly contents: Uint8Array | string;
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

export interface SandboxRunOptions {
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: SandboxProgress) => void;
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
  close(): void;
}
