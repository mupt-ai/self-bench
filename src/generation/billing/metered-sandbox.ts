import type {
  SandboxExecutor,
  SandboxRequest,
  SandboxResult,
  SandboxRunOptions,
} from "../../sandbox/contracts.js";
import { managedModelCostUsd, managedSandboxCostUsd } from "./pricing.js";
import { PiUsageMeter, recordStageUsage, type StageUsage } from "./usage.js";

export interface MeteredSandboxOptions {
  /** Set when this run's model access is managed (SelfBench's own OpenRouter key). */
  readonly managedModel: boolean;
  /** Set when this run's sandbox is managed (SelfBench's own E2B account). */
  readonly managedSandbox: boolean;
  /** The canonical generation model id this stage's agent invokes, for cost rates. */
  readonly model?: string;
  /** Runtime provider; only E2B has a sandbox rate in the existing pricing catalog. */
  readonly sandboxProvider?: "docker" | "e2b" | "modal" | "vercel";
  /** Pi model provider stored alongside model usage. */
  readonly provider?: string;
}

/**
 * A sandbox executor that records compute time and Pi token usage per stage. Managed flags
 * separately determine which recorded usage is billable by the platform.
 */
export function meteredSandboxExecutor(
  inner: SandboxExecutor,
  options: MeteredSandboxOptions,
): SandboxExecutor {
  return new Proxy(inner, {
    get(target, property) {
      if (property === "run")
        return (request: SandboxRequest, runOptions?: SandboxRunOptions) =>
          runMetered(target, request, runOptions, options);
      // Class methods use private fields, so they must be bound to the real instance.
      if (property === "constructor") return Reflect.get(target, property, target);
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function runMetered(
  inner: SandboxExecutor,
  request: SandboxRequest,
  runOptions: SandboxRunOptions | undefined,
  options: MeteredSandboxOptions,
): Promise<SandboxResult> {
  const meter = new PiUsageMeter();
  const started = Date.now();
  const pricedSandbox = options.sandboxProvider === "e2b";
  const snapshot = () => {
    const seconds = Math.max(1, Math.ceil((Date.now() - started) / 1000));
    const usage = meter.usage();
    const modelUsd = options.model ? managedModelCostUsd(options.model, usage) : undefined;
    const modelPriced = options.model !== undefined && modelUsd !== undefined;
    const state =
      pricedSandbox && (options.model === undefined || modelPriced)
        ? "estimated"
        : pricedSandbox || modelPriced
          ? "partial"
          : options.sandboxProvider
            ? "unpriced"
            : "unknown";
    runOptions?.onCost?.({
      stage: request.stage,
      state,
      sandboxSeconds: seconds,
      ...(pricedSandbox
        ? { sandboxUsd: managedSandboxCostUsd(seconds, request.cpu, request.memoryMiB) }
        : {}),
      ...(modelUsd !== undefined ? { modelUsd } : {}),
      updatedAt: new Date().toISOString(),
    });
  };
  snapshot();
  const live = setInterval(snapshot, 5_000);
  live.unref();
  try {
    return await inner.run(request, {
      ...runOptions,
      onOutput: (stream, chunk) => {
        if (stream === "stdout") meter.push(chunk);
        runOptions?.onOutput?.(stream, chunk);
        snapshot();
      },
    });
  } finally {
    clearInterval(live);
    snapshot();
    const seconds = Math.max(1, Math.ceil((Date.now() - started) / 1000));
    const usage = meter.usage();
    const modelCostUsd = options.model ? managedModelCostUsd(options.model, usage) : undefined;
    const entry: StageUsage = {
      stage: request.stage,
      managed: options.managedModel || options.managedSandbox,
      managedModel: options.managedModel,
      managedSandbox: options.managedSandbox,
      sandboxSeconds: seconds,
      ...(options.provider ? { provider: options.provider } : {}),
      ...(request.cpu !== undefined ? { cpu: request.cpu } : {}),
      ...(request.memoryMiB !== undefined ? { memoryMiB: request.memoryMiB } : {}),
      ...(pricedSandbox
        ? { sandboxCostUsd: managedSandboxCostUsd(seconds, request.cpu, request.memoryMiB) }
        : {}),
      ...(usage.messages > 0
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
    await recordStageUsage(entry);
  }
}
