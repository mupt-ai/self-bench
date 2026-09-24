import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEnvFiles } from "../src/lib/env-file.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function envFile(name: string, body: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "selfbench-env-"));
  roots.push(root);
  const path = join(root, name);
  await writeFile(path, body);
  return path;
}

test("later env-files win, and values already set are kept", async () => {
  const shared = await envFile(
    "shared",
    "# shared\nA=shared\nB=shared\nURL=postgres://u:p@h/db?x=1\n",
  );
  const api = await envFile("api", "B=api\nC=api\n");
  const environment: NodeJS.ProcessEnv = { C: "service" };
  loadEnvFiles([shared, api], environment);
  expect(environment).toEqual({
    A: "shared",
    B: "api",
    C: "service",
    URL: "postgres://u:p@h/db?x=1",
  });
});

test("a missing or empty env-file is an error", async () => {
  const empty = await envFile("empty", "# nothing\n");
  expect(() => loadEnvFiles([empty], {})).toThrow("missing or empty");
  expect(() => loadEnvFiles([join(tmpdir(), "selfbench-no-such-env")], {})).toThrow(
    "missing or empty",
  );
});
