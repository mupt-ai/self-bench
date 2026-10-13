import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { CredentialInfo } from "../../../../src/db/credentials";
import type { CatalogModel } from "../../../../src/evaluation/catalog";
import { RunModelRow } from "./RunModelRow";

test("a Meta key runs every harness and a Meta or Claude sign-in only its own CLI", () => {
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
    { id: "muse-login", name: "Muse", kind: "meta", auth: "muse-login" },
    { id: "claude-login", name: "Claude", kind: "anthropic", auth: "claude-login" },
  ] as CredentialInfo[];
  const harnesses = (model: CatalogModel, credentialId: string) =>
    [
      ...(renderToStaticMarkup(
        <RunModelRow
          model={model}
          credentials={credentials}
          selection={{ catalogId: model.id, credentialId, harnesses: [] }}
          onChange={() => {}}
        />,
      )
        .split(`aria-label="${model.label} Harness"`)[1]
        ?.matchAll(/value="([^"]+)"/g) ?? []),
    ].map((match) => match[1]);
  expect(harnesses(spark, "meta-key")).toEqual([
    "codex",
    "claude-code",
    "pi",
    "mini-swe-agent",
    "terminus-2",
    "muse-code",
  ]);
  expect(harnesses(spark, "muse-login")).toEqual(["muse-code"]);
  expect(harnesses(opus, "claude-login")).toEqual(["claude-code"]);
});
