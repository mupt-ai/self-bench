import { executionEnvironment } from "../../contracts/config/execution-environment.js";
import { runCommand } from "../../lib/process.js";

export async function githubToken(): Promise<string | undefined> {
  const token = executionEnvironment().GH_TOKEN;
  if (token) {
    return token;
  }
  const result = await runCommand("gh", ["auth", "token"], { allowFailure: true });
  return result.exitCode === 0 && result.stdout.trim() ? result.stdout.trim() : undefined;
}
