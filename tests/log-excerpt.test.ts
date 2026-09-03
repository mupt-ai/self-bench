import { describe, expect, test } from "bun:test";
import { COMPOSE_DIAGNOSTICS_MARKER, excerptLog, filterProgressNoise } from "../src/log-excerpt.js";

const progress = Array.from({ length: 300 }, (_unused, index) =>
  [
    `${(index * 7919).toString(16).padStart(12, "0").slice(0, 12)}: Downloading [=====>     ]  12.3MB/45.6MB`,
    `${(index * 104729).toString(16).padStart(12, "0").slice(0, 12)}: Pull complete`,
    `#${index} sha256:${"a".repeat(64)} 4.19MB / 4.19MB 0.3s`,
    `#${index} extracting sha256:${"b".repeat(64)} done`,
    `#${index} DONE 0.4s`,
    "",
    "",
  ].join("\n"),
).join("\n");

describe("log excerpt", () => {
  test("drops pull and extract progress and keeps the real error with context", () => {
    const raw = [
      progress,
      "#12 [4/9] RUN apt-get install -y --no-install-recommends libpq-dev",
      "#12 0.812 Reading package lists...",
      "#12 1.203 E: Unable to locate package libpq-dev",
      '#12 ERROR: process "/bin/sh -c apt-get install -y libpq-dev" did not complete successfully: exit code: 100',
      "------",
      progress,
    ].join("\n");

    const excerpt = excerptLog(raw);

    expect(excerpt).toContain("E: Unable to locate package libpq-dev");
    expect(excerpt).toContain("did not complete successfully: exit code: 100");
    expect(excerpt).toContain("RUN apt-get install");
    expect(excerpt).not.toContain("Pull complete");
    expect(excerpt).not.toContain("Downloading");
    expect(excerpt).not.toContain("extracting sha256");
    expect(excerpt).not.toMatch(/#\d+ DONE/);
    expect(Buffer.byteLength(excerpt)).toBeLessThanOrEqual(6_000);
    expect(excerpt.startsWith("## Error lines")).toBe(true);
  });

  test("includes the compose diagnostics block and the tail, within budget", () => {
    const raw = [
      ...Array.from({ length: 200 }, (_unused, index) => `step ${index} ok`),
      "dependency failed to start: container postgres is unhealthy",
      "",
      `${COMPOSE_DIAGNOSTICS_MARKER} (project harbor-x)`,
      "NAME       STATUS",
      "postgres   Exited (1)",
      "postgres | FATAL: password authentication failed",
      "",
      "trailing line",
    ].join("\n");

    const excerpt = excerptLog(raw, { budgetBytes: 1_500, tailLines: 5 });

    expect(excerpt).toContain("container postgres is unhealthy");
    expect(excerpt).toContain(`${COMPOSE_DIAGNOSTICS_MARKER} (project harbor-x)`);
    expect(excerpt).toContain("postgres   Exited (1)");
    expect(excerpt).toContain("## Last 5 lines");
    expect(excerpt).toContain("trailing line");
    expect(excerpt).not.toContain("step 100 ok");
    expect(Buffer.byteLength(excerpt)).toBeLessThanOrEqual(1_500);
  });

  test("filters spinners and collapses blank runs but keeps ordinary output", () => {
    expect(
      filterProgressNoise(
        "Progress: resolved 1200, reused 1100, downloaded 100, added 0\r\n| Resolving\n\n\n\nnpm WARN deprecated foo@1\nbuilt in 2s\n",
      ),
    ).toEqual(["built in 2s"]);
    expect(excerptLog("")).toBe("");
  });
});
