import { expect, test } from "bun:test";
import type { CredentialInfo } from "../../../../src/db/credentials";
import type { CatalogModel } from "../../../../src/evaluation/catalog";
import { rowHarnessOptions } from "./row-harness-options";

test("a Meta key runs every harness, and Claude via Dari only Claude Code", () => {
  const spark: CatalogModel = {
    id: "muse-spark-test",
    label: "Muse Spark Test",
    provider: "meta",
    model: "muse-spark-test",
    harnesses: ["muse-code"],
    source: "",
  };
  const opus: CatalogModel = {
    ...spark,
    id: "opus-test",
    label: "Opus Test",
    provider: "anthropic",
  };
  const credentials = [
    { id: "meta-key", name: "Meta", kind: "meta", auth: "api-key" },
    {
      id: "claude-dari",
      name: "Dari",
      kind: "dari-link",
      auth: "dari-link",
      linkModels: {
        models: [{ id: "anthropic/muse-spark-test", only: "claude-code" }],
        prefixes: [],
      },
    },
  ] as CredentialInfo[];
  const harnesses = (model: CatalogModel, credentialId: string) =>
    rowHarnessOptions(
      model,
      credentials.find((entry) => entry.id === credentialId),
      undefined,
      undefined,
    ).map((option) => option.id);
  expect(harnesses(spark, "meta-key")).toEqual([
    "codex",
    "claude-code",
    "pi",
    "mini-swe-agent",
    "terminus-2",
    "muse-code",
  ]);
  expect(harnesses(opus, "claude-dari")).toEqual(["claude-code"]);
});
