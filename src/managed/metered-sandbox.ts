import type {
  SandboxExecutor,
  SandboxRequest,
  SandboxResult,
  SandboxRunOptions,
} from "../sandbox/contracts.js";
import { managedModelCostUsd, managedSandboxCostUsd } from "./pricing.js";
import { PiUsageMeter, recordStageUsage, type StageUsage } from "./usage.js";

export interface MeteredSandboxOptions {
  /** Set when this run's model access is managed (SelfBench's own OpenRouter key). */
  readonly managedModel: boolean;
  /** Set when this run's sandbox is managed (SelfBench's own E2B account). */
  readonly managedSandbox: boolean;
  /** The canonical generation model id this stage's agent invokes, for cost rates. */
  readonly model?: string;
}

/**
 * A sandbox executor that records compute time and Pi token usage per stage. Usage is only
 * metered for managed resources: the platform pays for managed models and managed E2B.
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
  if (!options.managedModel && !options.managedSandbox) return await inner.run(request, runOptions);
  const meter = new PiUsageMeter();
  const started = Date.now();
  try {
    return await inner.run(request, {
      ...runOptions,
      onOutput: (stream, chunk) => {
        if (stream === "stdout") meter.push(chunk);
        runOptions?.onOutput?.(stream, chunk);
      },
    });
  } finally {
    const seconds = Math.max(1, Math.round((Date.now() - started) / 1000));
    const usage = meter.usage();
    const entry: StageUsage = {
      stage: request.stage,
      managed: options.managedSandbox,
      sandboxSeconds: seconds,
      ...(request.cpu !== undefined ? { cpu: request.cpu } : {}),
      ...(request.memoryMiB !== undefined ? { memoryMiB: request.memoryMiB } : {}),
      ...(options.managedSandbox
        ? { sandboxCostUsd: managedSandboxCostUsd(seconds, request.cpu, request.memoryMiB) }
        : {}),
      ...(usage.messages > 0
        ? {
            tokens: {
              input: usage.input,
              output: usage.output,
              cacheRead: usage.cacheRead,
              cacheWrite: usage.cacheWrite,
            },
            ...(options.managedModel && options.model
              ? (() => {
                  const cost = managedModelCostUsd(options.model ?? "", usage);
                  return cost !== undefined ? { modelCostUsd: cost } : {};
                })()
              : {}),
          }
        : {}),
    };
    await recordStageUsage(entry);
  }
}
