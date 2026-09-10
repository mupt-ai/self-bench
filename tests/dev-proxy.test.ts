import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  devProxyFor,
  proxiedOrigin,
  registerSite,
  renderSite,
  unregisterSite,
} from "../src/cli/dev-proxy.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("dev proxy", () => {
  test("is off without a domain and requires the machine address with one", () => {
    expect(devProxyFor({})).toBeUndefined();
    expect(() => devProxyFor({ SELFBENCH_DEV_DOMAIN: "stack.example.test" })).toThrow(
      "SELFBENCH_DEV_PROXY_IP",
    );
    expect(
      devProxyFor({
        SELFBENCH_DEV_DOMAIN: " Stack.Example.test ",
        SELFBENCH_DEV_PROXY_IP: "100.64.0.1",
        SELFBENCH_CONFIG_DIR: "/cfg",
      }),
    ).toEqual({
      domain: "stack.example.test",
      ip: "100.64.0.1",
      port: "80",
      sites: "/cfg/dev-proxy/sites",
    });
    expect(proxiedOrigin({ port: "80" }, "wt.stack.example.test")).toBe(
      "http://wt.stack.example.test",
    );
    expect(proxiedOrigin({ port: "8000" }, "stack.example.test")).toBe(
      "http://stack.example.test:8000",
    );
  });

  test("renders a plain-http site that forwards to the stack's host port", () => {
    expect(renderSite("wt.stack.example.test", "8281")).toBe(
      "http://wt.stack.example.test {\n\treverse_proxy host.docker.internal:8281\n}\n",
    );
  });

  test("register writes the site file and unregister removes it, without a running proxy", async () => {
    const root = await mkdtemp(join(tmpdir(), "selfbench-dev-proxy-"));
    roots.push(root);
    const proxy = {
      domain: "stack.example.test",
      ip: "100.64.0.1",
      port: "80",
      sites: join(root, "sites"),
    };
    const file = join(proxy.sites, "wt.caddy");

    await registerSite(proxy, "wt", "wt.stack.example.test", "8281");
    expect(await readFile(file, "utf8")).toContain("host.docker.internal:8281");

    await unregisterSite(proxy, "wt");
    await expect(readFile(file, "utf8")).rejects.toThrow();
  });
});
