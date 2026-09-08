import { readFileSync } from "node:fs";

/** Assets live beside this module in source, built code, and standalone sandbox bundles. */
export function verifierRuntimeFiles(): Readonly<Record<string, string>> {
  return {
    "runtime/command.sh": readFileSync(new URL("./runtime/command.sh", import.meta.url), "utf8"),
    "runtime/junit.py": readFileSync(new URL("./runtime/junit.py", import.meta.url), "utf8"),
  };
}
