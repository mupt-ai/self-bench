import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { siteTaskSource } from "./task/site-source";
import { UploadSheet } from "./UploadSheet";
import { uploadArchive } from "./upload-api";

test("upload UI is explicit about limits and unverified nonexecution", () => {
  const html = renderToStaticMarkup(
    <UploadSheet org="me" fullName="me/repo" onClose={() => {}} onImported={() => {}} />,
  );
  expect(html).toContain("Uploaded / unverified");
  expect(html).toContain("Validate archive");
  expect(html).toContain("128 MiB expanded");
  expect(html).not.toContain("Attach Run");
});
test("client sends original bytes with preview receipt, errors are surfaced", async () => {
  const original = globalThis.fetch;
  const calls: RequestInit[] = [];
  globalThis.fetch = (async (_path: RequestInfo | URL, init?: RequestInit) => {
    calls.push(init ?? {});
    return Response.json({ imported: 1 });
  }) as unknown as typeof fetch;
  try {
    const file = new File(["archive"], "tasks.tar.gz");
    await uploadArchive("me", "me/repo", file, "signed-preview");
    expect(calls[0]?.body).toBe(file);
    expect(calls[0]?.headers).toMatchObject({
      "x-upload-preview": "signed-preview",
      "content-type": "application/octet-stream",
    });
    globalThis.fetch = (async () =>
      Response.json({ error: "conflicts changed" }, { status: 409 })) as unknown as typeof fetch;
    await expect(uploadArchive("me", "me/repo", file)).rejects.toThrow("conflicts changed");
  } finally {
    globalThis.fetch = original;
  }
});
test("uploaded files use tenant-scoped routes, never legacy global run routes", async () => {
  const original = globalThis.fetch;
  let requested = "";
  globalThis.fetch = (async (path: RequestInfo | URL) => {
    requested = String(path);
    return Response.json({ taskId: "t", files: [] });
  }) as unknown as typeof fetch;
  try {
    const source = siteTaskSource("me", "me/repo", {
      runId: "upload-abc",
      taskId: "t",
      candidateId: "t",
      difficulty: "unknown",
      stage: "uploaded",
      pipelineStatus: "uploaded",
      state: "uploaded",
      syncedAt: "",
    });
    await source.loadFiles("t");
    expect(requested).toBe("/api/orgs/me/repos/me/repo/uploads/upload-abc/t/bundle");
    expect(source.artifacts).toBeUndefined();
  } finally {
    globalThis.fetch = original;
  }
});
