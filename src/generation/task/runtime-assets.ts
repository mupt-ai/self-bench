import { readFileSync } from "node:fs";

export function verifierRuntimeFiles(): Readonly<Record<string, string>> {
  return {
    "runtime/command.sh": readFileSync(new URL("./runtime/command.sh", import.meta.url), "utf8"),
  };
}
