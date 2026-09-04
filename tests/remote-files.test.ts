import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { materializeRemoteFiles, remoteFileFetchScript } from "../src/sandbox/remote-files.js";

describe("remote sandbox files", () => {
  test("the in-sandbox fetch script downloads with retries and verifies the digest", () => {
    const script = remoteFileFetchScript({
      path: "/work/task.tar.gz",
      url: "https://storage.example/bundle?sig=a'b",
      sha256: "abc123",
    });
    expect(script).toContain("mkdir -p \"$(dirname '/work/task.tar.gz')\"");
    expect(script).toContain("curl -fsSL --retry 5 --retry-all-errors");
    expect(script).toContain("-o '/work/task.tar.gz' 'https://storage.example/bundle?sig=a'\\''b'");
    expect(script).toContain("'abc123' '/work/task.tar.gz'");
    expect(script).toContain("sha256sum -c -");
  });

  test("the worker-side fallback fetches, verifies, and rejects a digest mismatch", async () => {
    const body = Buffer.from("bundle bytes");
    const server = Bun.serve({ port: 0, fetch: () => new Response(body) });
    try {
      const url = `http://127.0.0.1:${server.port}/bundle`;
      const sha256 = createHash("sha256").update(body).digest("hex");
      const files = await materializeRemoteFiles([
        { path: "/work/a.txt", contents: "inline" },
        { path: "/work/task.tar.gz", url, sha256 },
      ]);
      expect(files.map((file) => file.path)).toEqual(["/work/a.txt", "/work/task.tar.gz"]);
      expect(Buffer.from(files[1]?.contents as Uint8Array).toString()).toBe("bundle bytes");
      await expect(
        materializeRemoteFiles([{ path: "/work/task.tar.gz", url, sha256: "0".repeat(64) }]),
      ).rejects.toThrow(/digest mismatch/);
    } finally {
      server.stop(true);
    }
  });
});
