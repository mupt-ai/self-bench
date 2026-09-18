import { AsyncLocalStorage } from "node:async_hooks";
import type { SandboxExecutor } from "./contracts.js";

const executors = new AsyncLocalStorage<SandboxExecutor>();
/** Trusted task operations get a fresh allocation from the selected generation provider. */
export function withTaskSandbox<T>(
  executor: SandboxExecutor,
  action: () => Promise<T>,
): Promise<T> {
  return executors.run(executor, action);
}
export function taskSandbox(): SandboxExecutor {
  const executor = executors.getStore();
  if (!executor) throw new Error("Task operation requires a configured sandbox executor");
  return executor;
}
