import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { BuildInfo, LogEntry, TemplateClass } from "e2b";
import { buildSelfBenchE2BTemplate, type E2BTemplateBuildApi } from "../src/setup/e2b/index.js";

const credentials = { apiKey: "e2b_test_key" };

class FakeE2BTemplateBuildApi implements E2BTemplateBuildApi {
  readonly calls: string[] = [];
  fromDockerfileResult = "template-from-dockerfile";
  buildResult: BuildInfo = {
    alias: "selfbench-runtime",
    name: "selfbench-runtime:v1",
    tags: ["v1"],
    templateId: "tpl_test",
    buildId: "bld_test",
  };
  throwOnBuild: unknown;

  fromDockerfile(dockerfile: string, contextDirectory: string): TemplateClass {
    this.calls.push(`fromDockerfile:${dockerfile}:${contextDirectory}`);
    return this.fromDockerfileResult as unknown as TemplateClass;
  }

  async build(
    template: TemplateClass,
    name: string,
    options: {
      readonly cpuCount: number;
      readonly memoryMB: number;
      readonly onBuildLogs: (entry: LogEntry) => void;
      readonly requestTimeoutMs: number;
      readonly signal?: AbortSignal;
    },
  ): Promise<BuildInfo> {
    this.calls.push(
      `build:${template as unknown as string}:${name}:${options.cpuCount}:${options.memoryMB}:${options.requestTimeoutMs}`,
    );
    if (this.throwOnBuild) {
      throw this.throwOnBuild;
    }
    return this.buildResult;
  }
}

describe("buildSelfBenchE2BTemplate", () => {
  test("keeps the work directory writable and excludes common local secrets from context", async () => {
    const dockerfile = await Bun.file(resolve(import.meta.dir, "../Dockerfile.sandbox")).text();
    const dockerignore = await Bun.file(resolve(import.meta.dir, "../.dockerignore")).text();
    expect(dockerfile).toContain("RUN mkdir -p /work && chmod 0777 /work\n\nWORKDIR /work");
    expect(dockerignore).toContain(".env\n");
    expect(dockerignore).toContain("*.pem\n");
    expect(dockerignore).toContain("*.key\n");
  });

  test("builds Dockerfile.sandbox under the requested versioned name", async () => {
    const api = new FakeE2BTemplateBuildApi();
    const logs: string[] = [];

    const result = await buildSelfBenchE2BTemplate({
      name: "selfbench-runtime:v1",
      cpuCount: 4,
      memoryMiB: 8192,
      credentials,
      projectRoot: "/repo",
      api,
      onLog: (message) => logs.push(message),
    });

    expect(result).toEqual(api.buildResult);
    expect(api.calls).toHaveLength(2);
    expect(api.calls[0]).toBe("fromDockerfile:/repo/Dockerfile.sandbox:/repo");
    expect(api.calls[1]).toBe("build:template-from-dockerfile:selfbench-runtime:v1:4:8192:60000");
  });

  test("rejects an invalid name or resource values before any SDK work", async () => {
    const api = new FakeE2BTemplateBuildApi();

    await expect(
      buildSelfBenchE2BTemplate({
        name: "   ",
        cpuCount: 4,
        memoryMiB: 8192,
        credentials,
        projectRoot: "/repo",
        api,
      }),
    ).rejects.toThrow("template reference must not be blank");
    for (const name of ["Uppercase", "team/selfbench-runtime", "selfbench-runtime:v1:extra"]) {
      await expect(
        buildSelfBenchE2BTemplate({
          name,
          cpuCount: 4,
          memoryMiB: 8192,
          credentials,
          projectRoot: "/repo",
          api,
        }),
      ).rejects.toThrow(/invalid E2B template reference|must not include a team namespace/);
    }
    await expect(
      buildSelfBenchE2BTemplate({
        name: "selfbench-runtime",
        cpuCount: 0,
        memoryMiB: 8192,
        credentials,
        projectRoot: "/repo",
        api,
      }),
    ).rejects.toThrow("CPU count");
    await expect(
      buildSelfBenchE2BTemplate({
        name: "selfbench-runtime",
        cpuCount: 4,
        memoryMiB: 0,
        credentials,
        projectRoot: "/repo",
        api,
      }),
    ).rejects.toThrow("memory");
    await expect(
      buildSelfBenchE2BTemplate({
        name: "selfbench-runtime",
        cpuCount: 4,
        memoryMiB: 8192,
        credentials: { apiKey: "  " },
        projectRoot: "/repo",
        api,
      }),
    ).rejects.toThrow("nonblank API key");
    await expect(
      buildSelfBenchE2BTemplate({
        name: "selfbench-runtime",
        cpuCount: 4,
        memoryMiB: 8192,
        credentials: { apiKey: "test", domain: "https://e2b.example/path" },
        projectRoot: "/repo",
        api,
      }),
    ).rejects.toThrow("hostname without a scheme or path");
    expect(api.calls).toEqual([]);
  });

  test("rejects incomplete build identifiers instead of printing unusable configuration", async () => {
    const api = new FakeE2BTemplateBuildApi();
    api.buildResult = { ...api.buildResult, buildId: "" };

    await expect(
      buildSelfBenchE2BTemplate({
        name: "selfbench-runtime:v1",
        cpuCount: 4,
        memoryMiB: 8192,
        credentials,
        projectRoot: "/repo",
        api,
      }),
    ).rejects.toThrow("incomplete template or build identifiers");
  });
});
