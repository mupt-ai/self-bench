import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectNameFor, stackEnvironment } from "../src/cli/stack-environment.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("stackEnvironment", () => {
  test("the canonical checkout keeps the historical project, ports, and images", () => {
    expect(stackEnvironment("/Users/me/code/self-bench", {})).toEqual({
      COMPOSE_PROJECT_NAME: "selfbench",
      SELFBENCH_SITE_HOSTNAME: "127.0.0.1",
      SELFBENCH_IMAGE: "selfbench:local",
      SELFBENCH_DOCKER_IMAGE: "selfbench-sandbox:local",
      SELFBENCH_SITE_PORT: "8080",
      SELFBENCH_SITE_BIND: "127.0.0.1",
      SELFBENCH_TEMPORAL_PORT: "7233",
      SELFBENCH_PUBLIC_URL: "http://127.0.0.1:8080",
    });
  });

  test("a worktree gets its own project, images, and stable non-default ports", () => {
    const a = stackEnvironment("/Users/me/.worktrees/avyay-harbor-review-page", {});
    const b = stackEnvironment("/Users/me/.worktrees/avyay-harbor-runner", {});

    expect(a.COMPOSE_PROJECT_NAME).toBe("avyay-harbor-review-page");
    expect(a.SELFBENCH_IMAGE).toBe("avyay-harbor-review-page-selfbench:local");
    expect(a.SELFBENCH_DOCKER_IMAGE).toBe("avyay-harbor-review-page-sandbox:local");
    expect(a.SELFBENCH_PUBLIC_URL).toBe(`http://127.0.0.1:${a.SELFBENCH_SITE_PORT}`);
    for (const stack of [a, b]) {
      expect(Number(stack.SELFBENCH_SITE_PORT)).toBeGreaterThanOrEqual(8100);
      expect(Number(stack.SELFBENCH_SITE_PORT)).toBeLessThan(8900);
      expect(Number(stack.SELFBENCH_TEMPORAL_PORT)).toBeGreaterThanOrEqual(7300);
      expect(Number(stack.SELFBENCH_TEMPORAL_PORT)).toBeLessThan(8100);
    }
    expect(a.SELFBENCH_SITE_PORT).not.toBe(b.SELFBENCH_SITE_PORT);
    // Stable: the same worktree lands on the same port every start.
    expect(stackEnvironment("/Users/me/.worktrees/avyay-harbor-review-page", {})).toEqual(a);
  });

  test("a non-loopback hostname binds all interfaces and forms the public URL", () => {
    const stack = stackEnvironment("/w/feature-x", {
      SELFBENCH_SITE_HOSTNAME: "box.example.ts.net",
    });
    expect(stack.SELFBENCH_SITE_BIND).toBe("0.0.0.0");
    expect(stack.SELFBENCH_PUBLIC_URL).toBe(
      `http://box.example.ts.net:${stack.SELFBENCH_SITE_PORT}`,
    );
  });

  test("explicit environment wins over every derived value", () => {
    expect(
      stackEnvironment("/w/feature-x", {
        COMPOSE_PROJECT_NAME: "custom",
        SELFBENCH_IMAGE: "registry/selfbench:v1",
        SELFBENCH_DOCKER_IMAGE: "registry/sandbox:v1",
        SELFBENCH_SITE_PORT: "9000",
        SELFBENCH_SITE_BIND: "10.0.0.5",
        SELFBENCH_TEMPORAL_PORT: "9001",
        SELFBENCH_PUBLIC_URL: "https://bench.example.com/",
      }),
    ).toEqual({
      COMPOSE_PROJECT_NAME: "custom",
      SELFBENCH_SITE_HOSTNAME: "127.0.0.1",
      SELFBENCH_IMAGE: "registry/selfbench:v1",
      SELFBENCH_DOCKER_IMAGE: "registry/sandbox:v1",
      SELFBENCH_SITE_PORT: "9000",
      SELFBENCH_SITE_BIND: "10.0.0.5",
      SELFBENCH_TEMPORAL_PORT: "9001",
      SELFBENCH_PUBLIC_URL: "https://bench.example.com",
    });
  });

  test("reads the checkout's .env like Compose does, below the process environment", async () => {
    const root = await mkdtemp(join(tmpdir(), "selfbench-stack-env-"));
    roots.push(root);
    await writeFile(
      join(root, ".env"),
      '# shared settings\nSELFBENCH_SITE_HOSTNAME="box.example.ts.net"\nSELFBENCH_TEMPORAL_PORT=7999\n',
    );

    const stack = stackEnvironment(root, { SELFBENCH_TEMPORAL_PORT: "7500" });
    expect(stack.SELFBENCH_PUBLIC_URL).toBe(
      `http://box.example.ts.net:${stack.SELFBENCH_SITE_PORT}`,
    );
    expect(stack.SELFBENCH_SITE_BIND).toBe("0.0.0.0");
    expect(stack.SELFBENCH_TEMPORAL_PORT).toBe("7500");
  });

  test("an external proxy URL preserves the local bind address and port", () => {
    const stack = stackEnvironment("/w/feature-x", {
      SELFBENCH_PUBLIC_URL: "https://feature-x.example.test/",
      SELFBENCH_SITE_PORT: "8281",
    });
    expect(stack.SELFBENCH_PUBLIC_URL).toBe("https://feature-x.example.test");
    expect(stack.SELFBENCH_SITE_BIND).toBe("127.0.0.1");
    expect(stack.SELFBENCH_SITE_PORT).toBe("8281");
  });

  test("project names are valid Compose names", () => {
    expect(projectNameFor("/w/Feature X.2")).toBe("feature-x-2");
    expect(projectNameFor("/w/.hidden")).toBe("hidden");
    expect(projectNameFor("/w/self-bench")).toBe("selfbench");
    expect(projectNameFor("/w/selfbench")).toBe("selfbench");
  });
});
