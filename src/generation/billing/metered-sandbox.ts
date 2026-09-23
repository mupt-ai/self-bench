import type {
  ModelUsage,
  SandboxCostSnapshot,
  SandboxExecutor,
  SandboxProvider,
  SandboxRequest,
  SandboxResult,
  SandboxRunOptions,
  StartedSandbox,
} from "../../sandbox/contracts.js";
import { managedModelCostUsd, managedSandboxCostUsd } from "./pricing.js";
import { recordStageUsage, type StageUsage } from "./usage.js";

export interface MeteredSandboxOptions {
  /** The canonical generation model id this stage's agent invokes, for cost rates. */
  readonly model?: string;
  /** Runtime provider; only E2B has a sandbox rate in the existing pricing catalog. */
  readonly sandboxProvider?: SandboxProvider;
  /** Set when this run's model access is managed (SelfBench's own OpenRouter key). */
  readonly managedModel: boolean;
  /** Set when this run's sandbox is managed (SelfBench's own E2B account). */
  readonly managedSandbox: boolean;
  /** Pi model provider stored alongside model usage. */
  readonly provider?: string;
}

/**
 * A sandbox executor that records compute time and model tokens per stage. A started sandbox is
 * billed for its whole life, from start to stop, with the tokens its job reported. Managed flags
 * separately determine which recorded usage is billable by the platform.
 */
export function meteredSandboxExecutor(
  inner: SandboxExecutor,
  options: MeteredSandboxOptions,
): SandboxExecutor {
  return new Proxy(inner, {
    get(target, property) {
      if (property === "run")
        return async (request: SandboxRequest, runOptions?: SandboxRunOptions) => {
          const started = Date.now();
          try {
            return (await target.run(request, runOptions)) satisfies SandboxResult;
          } finally {
            await recordStageUsage(
              stageUsage(request.stage, secondsSince(started), request, options),
            );
          }
        };
      // The sandbox carries its rates so the callback API can price it while it runs.
      if (property === "start")
        return async (
          request: SandboxRequest,
          secretsFor?: (sandbox: StartedSandbox) => Readonly<Record<string, string>>,
        ) => {
          const rates = {
            ...(options.model ? { model: options.model } : {}),
            ...(options.sandboxProvider ? { sandboxProvider: options.sandboxProvider } : {}),
          };
          const started = await target.start(
            request,
            secretsFor && ((sandbox) => secretsFor({ ...sandbox, rates })),
          );
          return { ...started, rates };
        };
      if (property === "stop")
        return async (sandbox: StartedSandbox, usage?: ModelUsage) => {
          await target.stop(sandbox);
          const seconds = secondsSince(Date.parse(sandbox.startedAt));
          await recordStageUsage(stageUsage(sandbox.stage, seconds, sandbox, options, usage));
        };
      // Class methods use private fields, so they must be bound to the real instance.
      if (property === "constructor") return Reflect.get(target, property, target);
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** The live cost of a sandbox that is still running, for progress pages. */
export function costSnapshot(
  sandbox: StartedSandbox,
  usage: ModelUsage | undefined,
  now = Date.now(),
): SandboxCostSnapshot {
  const rates = sandbox.rates ?? {};
  const seconds = secondsSince(Date.parse(sandbox.startedAt), now);
  const pricedSandbox = rates.sandboxProvider === "e2b";
  const modelUsd = rates.model && usage ? managedModelCostUsd(rates.model, usage) : undefined;
  const modelPriced = rates.model !== undefined && modelUsd !== undefined;
  const state =
    pricedSandbox && (rates.model === undefined || modelPriced)
      ? "estimated"
      : pricedSandbox || modelPriced
        ? "partial"
        : rates.sandboxProvider
          ? "unpriced"
          : "unknown";
  return {
    stage: sandbox.stage,
    state,
    sandboxSeconds: seconds,
    ...(pricedSandbox
      ? { sandboxUsd: managedSandboxCostUsd(seconds, sandbox.cpu, sandbox.memoryMiB) }
      : {}),
    ...(modelUsd !== undefined ? { modelUsd } : {}),
    updatedAt: new Date(now).toISOString(),
  };
}

function stageUsage(
  stage: string,
  seconds: number,
  size: { readonly cpu?: number; readonly memoryMiB?: number },
  options: MeteredSandboxOptions,
  usage?: ModelUsage,
): StageUsage {
  const modelCostUsd =
    options.model && usage ? managedModelCostUsd(options.model, usage) : undefined;
  return {
    stage,
    managed: options.managedModel || options.managedSandbox,
    managedModel: options.managedModel,
    managedSandbox: options.managedSandbox,
    sandboxSeconds: seconds,
    ...(options.provider ? { provider: options.provider } : {}),
    ...(size.cpu !== undefined ? { cpu: size.cpu } : {}),
    ...(size.memoryMiB !== undefined ? { memoryMiB: size.memoryMiB } : {}),
    ...(options.sandboxProvider === "e2b"
      ? { sandboxCostUsd: managedSandboxCostUsd(seconds, size.cpu, size.memoryMiB) }
      : {}),
    ...(usage && usage.messages > 0
      ? {
          ...(options.model ? { model: options.model } : {}),
          tokens: {
            input: usage.input,
            output: usage.output,
            cacheRead: usage.cacheRead,
            cacheWrite: usage.cacheWrite,
          },
          ...(modelCostUsd !== undefined ? { modelCostUsd } : {}),
        }
      : {}),
  };
}

function secondsSince(started: number, now = Date.now()): number {
  return Math.max(1, Math.ceil((now - started) / 1000));
}
