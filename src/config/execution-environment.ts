import { AsyncLocalStorage } from "node:async_hooks";

const environments = new AsyncLocalStorage<NodeJS.ProcessEnv>();
export function executionEnvironment(): NodeJS.ProcessEnv {
  return environments.getStore() ?? process.env;
}
export function withExecutionEnvironment<T>(
  environment: NodeJS.ProcessEnv,
  action: () => Promise<T>,
) {
  return environments.run(environment, action);
}
