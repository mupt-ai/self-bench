import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskDefinition } from "../src/contracts.js";
import { JUNIT_READER } from "../src/harbor-task/junit.js";
import { shellQuote } from "../src/harbor-task/paths.js";
import { testScript } from "../src/harbor-task/verifier.js";
import { runCommand } from "../src/process.js";
import { nopGatePassed } from "../src/verify-report.js";

async function grade(xml: string | undefined, ids = ["suite::a"], exit = 0, link = false) {
  const root = await mkdtemp(join(tmpdir(), "selfbench-junit-test-"));
  try {
    const report = join(root, "report.xml");
    if (xml !== undefined) await writeFile(report, xml);
    if (link) await symlink(report, join(root, "link.xml"));
    const result = await runCommand(
      "python3",
      [
        "-c",
        JUNIT_READER,
        link ? join(root, "link.xml") : report,
        JSON.stringify(ids),
        String(exit),
      ],
      { allowFailure: true },
    );
    return { code: result.exitCode, evidence: JSON.parse(result.stdout) };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
const suite = (body: string) => `<testsuites><testsuite>${body}</testsuite></testsuites>`;
const pass = '<testcase classname="suite" name="a"/>';
const fail = '<testcase classname="suite" name="a"><failure message="assertion"/></testcase>';

describe("trusted JUnit evidence", () => {
  test("records named passes and assertion failures", async () => {
    expect(await grade(suite(pass))).toMatchObject({
      code: 0,
      evidence: { valid: true, tests: { "suite::a": "passed" } },
    });
    expect(await grade(suite(fail), undefined, 1)).toMatchObject({
      code: 10,
      evidence: { valid: true, tests: { "suite::a": "failed" } },
    });
  });
  test("mixed transitions cannot satisfy the no-solution gate", async () => {
    const result = await grade(
      suite(`${fail}<testcase classname="suite" name="b"/>`),
      ["suite::a", "suite::b"],
      1,
    );
    expect(result.code).toBe(1);
    const rewards = {
      patch_applied: 1,
      setup_completed: 1,
      fail_to_pass: 0,
      pass_to_pass: 1,
      structured_results: 1,
    };
    expect(nopGatePassed({ ...rewards, fail_to_pass_exit_code: 10 })).toBe(true);
    for (const code of [0, 1, 2, 127])
      expect(nopGatePassed({ ...rewards, fail_to_pass_exit_code: code })).toBe(false);
    expect(nopGatePassed(rewards)).toBe(false);
  });
  test("fails closed on missing, malformed, duplicate, skipped, error and unsafe XML", async () => {
    for (const xml of [
      undefined,
      "",
      "<bad>",
      "<wrong/>",
      suite(pass + pass),
      suite('<testcase classname="suite" name="b"/>'),
      suite('<testcase classname="suite" name="a"><skipped/></testcase>'),
      suite('<testcase classname="suite" name="a"><error/></testcase>'),
      `<!DOCTYPE x [<!ENTITY x "foo">]>${suite(pass)}`,
      `${suite(pass)}\0`,
    ]) {
      expect((await grade(xml)).code).toBe(2);
    }
    expect((await grade(suite(pass), undefined, 0, true)).code).toBe(2);
    expect((await grade(" ".repeat(8 * 1024 * 1024 + 1))).code).toBe(2);
  });
  test("rejects command-result disagreement and untracked failures on oracle", async () => {
    expect((await grade(suite(pass), undefined, 1)).code).toBe(2);
    expect((await grade(suite(fail), undefined, 0)).code).toBe(2);
    expect((await grade(suite(fail), undefined, 127)).code).toBe(2);
    expect(
      (
        await grade(
          suite(`${pass}<testcase classname="suite" name="b"><failure/></testcase>`),
          undefined,
          1,
        )
      ).code,
    ).toBe(1);
  });
});

test("generated command wrapper measures real reports and discards stale results", async () => {
  const root = await mkdtemp(join(tmpdir(), "selfbench-junit-wrapper-"));
  try {
    const reader = join(root, "reader.py");
    await writeFile(reader, JUNIT_READER);
    const task = {
      workdir: ".",
      testPaths: ["test.py"],
      testCommand: "pytest {tests}",
      failToPass: ["test.py"],
      passToPass: [],
      testResults: { format: "junit", failToPass: ["suite::a"], passToPass: [] },
    } as unknown as TaskDefinition;
    const rendered = testScript(task, "");
    const start = rendered.indexOf("run_verifier_command() {");
    const end = rendered.indexOf("protect_held_out_path() {");
    const wrapper = rendered.slice(start, end).replaceAll("/opt/selfbench/junit-reader.py", reader);
    // Exercise the generated wrapper without users, root privileges, Docker, or /app.
    const script = `#!/bin/bash
runuser() { shift 4; "$@"; }
chown() { :; }
kill_verifier_processes() { :; }
${wrapper}
run_verifier_command ${shellQuote(`printf %s '${suite(fail)}' > "$SELFBENCH_JUNIT_REPORT"; exit 1`)} '["suite::a"]'
printf 'FIRST=%s\n' "$?"
run_verifier_command ${shellQuote(`printf %s '${suite(pass)}' > "$SELFBENCH_JUNIT_REPORT"`)} '["suite::a"]'
printf 'SECOND=%s\n' "$?"
run_verifier_command 'true' '["suite::a"]'
printf 'THIRD=%s\n' "$?"
`;
    await writeFile(join(root, "run.sh"), script);
    const result = await runCommand("bash", [join(root, "run.sh")]);
    expect(result.stdout).toContain("FIRST=10");
    expect(result.stdout).toContain("SECOND=0");
    expect(result.stdout).toContain("THIRD=2");
    expect(result.stdout).toContain('"suite::a": "failed"');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
