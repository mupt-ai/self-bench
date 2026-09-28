import { readFileSync } from "node:fs";

function runtimeAsset(name: string): string {
  return readFileSync(new URL(`./runtime/${name}`, import.meta.url), "utf8");
}

export function agentRuntimeScript(): string {
  return runtimeAsset("agent-runtime.sh");
}

export function verifierRuntimeFiles(): Readonly<Record<string, string>> {
  return {
    "runtime/command.sh": runtimeAsset("command.sh"),
    "runtime/junit.py": runtimeAsset("junit.py"),
  };
}

/** Every runtime asset, shipped beside a sandboxed bundle that compiles or renders tasks. */
export function sandboxRuntimeFiles(): Readonly<Record<string, string>> {
  return { ...verifierRuntimeFiles(), "runtime/agent-runtime.sh": agentRuntimeScript() };
}
