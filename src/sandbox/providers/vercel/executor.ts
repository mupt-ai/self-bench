import { APIError, type Command, Sandbox } from "@vercel/sandbox";
import { sleep } from "../../../lib/util.js";
import type {
  SandboxExecutor,
  SandboxRequest,
  SandboxRunOptions,
  StartedSandbox,
} from "../../contracts.js";
import { runSandbox, type SandboxSession, startSandbox } from "../../session.js";
import { preventAmbiguousVercelCommandStartRetries, VercelCommandStartError } from "./fetch.js";
import { type VercelExecutionConfig, validateConfig, validateRequest } from "./validation.js";

const CREATE_RATE_LIMIT_RETRIES = 2;

/** Vercel Sandbox: a nonpersistent sandbox from the digest-pinned runtime image. */
export class VercelSandboxExecutor implements SandboxExecutor {
  readonly #config: VercelExecutionConfig;
  readonly #fetch: typeof globalThis.fetch;

  constructor(config: VercelExecutionConfig, fetch = globalThis.fetch) {
    this.#config = validateConfig(config);
    this.#fetch = preventAmbiguousVercelCommandStartRetries(fetch);
  }

  run(request: SandboxRequest, options?: SandboxRunOptions) {
    return runSandbox(() => this.open(request), request, options);
  }

  start(
    request: SandboxRequest,
    secretsFor?: (sandbox: StartedSandbox) => Readonly<Record<string, string>>,
  ) {
    return startSandbox(() => this.open(request), request, secretsFor);
  }

  async stop(sandbox: StartedSandbox): Promise<void> {
    const found = await Sandbox.get({
      ...this.#config.credentials,
      fetch: this.#fetch,
      name: sandbox.sandboxId,
      resume: false,
    }).catch(() => undefined);
    await found?.delete({ signal: AbortSignal.timeout(60_000) });
  }

  close(): void {}

  private async open(request: SandboxRequest): Promise<SandboxSession> {
    const { vcpus } = validateRequest(request);
    const name = `selfbench-${`${request.runId}-${request.stage}`.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 100)}-${crypto.randomUUID().slice(0, 12)}`;
    const sandbox = await this.#create(name, vcpus, request);
    const session = sandbox.currentSession();
    return {
      id: sandbox.name,
      write: async (path, contents) => {
        await session.writeFiles([{ path, content: contents }]);
      },
      read: async (path) =>
        (await session.readFileToBuffer({ path }).catch(() => null)) ?? undefined,
      exec: async ([cmd, ...args], { environment, signal, onOutput }) => {
        let command: Command;
        try {
          command = await session.runCommand({
            cmd: cmd ?? "true",
            args,
            cwd: "/work",
            detached: true,
            env: { ...environment },
            signal,
            timeoutMs: request.timeoutMs,
          });
        } catch (error) {
          if (error instanceof VercelCommandStartError) error.restorePublicName();
          throw error;
        }
        for await (const event of command.logs({ signal }))
          onOutput(event.stream, Buffer.from(event.data));
        return (await command.wait({ signal })).exitCode;
      },
      spawn: async ([cmd, ...args], environment) => {
        await session.runCommand({
          cmd: cmd ?? "true",
          args,
          cwd: "/work",
          detached: true,
          env: { ...environment },
          timeoutMs: request.timeoutMs,
        });
      },
      destroy: () => sandbox.delete({ signal: AbortSignal.timeout(60_000) }),
    };
  }

  /** Retries rate-limited creates, honoring Retry-After. */
  async #create(name: string, vcpus: number, request: SandboxRequest): Promise<Sandbox> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await Sandbox.create({
          ...this.#config.credentials,
          fetch: this.#fetch,
          image: this.#config.image,
          name,
          persistent: false,
          resources: { vcpus },
          signal: AbortSignal.timeout(60_000),
          tags: {
            selfbench_run: request.runId.slice(0, 256),
            selfbench_stage: request.stage.slice(0, 256),
          },
          timeout: request.timeoutMs,
        });
      } catch (error) {
        if (
          !(error instanceof APIError) ||
          error.response.status !== 429 ||
          attempt >= CREATE_RATE_LIMIT_RETRIES
        ) {
          throw error;
        }
        const retryAfter = Number(error.response.headers.get("retry-after"));
        await sleep(
          Number.isFinite(retryAfter) && retryAfter > 0
            ? Math.min(retryAfter * 1000, 60_000)
            : 30_000,
        );
      }
    }
  }
}
