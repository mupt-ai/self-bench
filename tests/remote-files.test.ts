import { describe, expect, test } from "bun:test";
import { remoteFileFetchScript } from "../src/sandbox/remote-files.js";

describe("remote sandbox files", () => {
  test("the in-sandbox fetch script downloads with retries and verifies the digest", () => {
    const script = remoteFileFetchScript({
      path: "/work/task.tar.gz",
      url: "https://storage.example/bundle?sig=a'b",
      sha256: "abc123",
    });
    expect(script).toContain("mkdir -p \"$(dirname '/work/task.tar.gz')\"");
    expect(script).toContain("curl -fsSL --retry 5 --retry-all-errors");
    expect(script).toContain(`-o '/work/task.tar.gz' 'https://storage.example/bundle?sig=a'"'"'b'`);
    expect(script).toContain("'abc123' '/work/task.tar.gz'");
    expect(script).toContain("sha256sum -c -");
  });
});
