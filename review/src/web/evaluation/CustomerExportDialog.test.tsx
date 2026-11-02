import { expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { CustomerExportButton } from "./CustomerExportDialog";
import { run } from "./results-fixture";
import { setupTrialDialogTests } from "./trial-dialog-fixture";

setupTrialDialogTests();
const button = (text: string) =>
  [...document.querySelectorAll("button")].find((entry) => entry.textContent === text);

test("customer export submits a customer name, then offers the download and a revoke", async () => {
  const posts: { url: string; body: Record<string, string> }[] = [];
  const evaluation = run("12345678-1234-4234-8234-123456789abc", { status: "completed" }, []);
  let status: "ready" | "revoked" | undefined;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (init?.body) {
      posts.push({ url, body: JSON.parse(String(init.body)) });
      status = url.endsWith("/revoke") ? "revoked" : "ready";
      return Response.json({}, { status: 201 });
    }
    return Response.json({
      enabled: true,
      exports: status
        ? [
            {
              id: "export-id",
              customer: "Acme",
              evaluationId: evaluation.id,
              evaluationCreatedAt: evaluation.createdAt,
              createdAt: "2026-10-01T00:00:00Z",
              expiresAt: "2026-10-31T00:00:00Z",
              status,
            },
          ]
        : [],
    });
  }) as typeof fetch;
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () =>
    root.render(<CustomerExportButton url="/evaluations" runs={[evaluation]} />),
  );
  await act(async () => button("Export for Customer")?.click());
  const inputs = [...document.querySelectorAll("input")];
  expect(inputs).toHaveLength(1);
  const input = inputs[0];
  if (!input) throw new Error("Missing customer field");
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  Object.assign(input, { attachEvent() {}, detachEvent() {} });
  await act(async () => input.dispatchEvent(new window.Event("focusin", { bubbles: true })));
  await act(async () => {
    setter?.call(input, "Acme");
    input.dispatchEvent(new window.Event("keyup", { bubbles: true }));
  });
  await act(async () =>
    document
      .querySelector("form")
      ?.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })),
  );
  expect(posts[0]?.body).toMatchObject({ customer: "Acme" });
  expect(Object.keys(posts[0]?.body ?? {}).sort()).toEqual(["customer", "id"]);
  const link = [...document.querySelectorAll("a")].find(
    (entry) => entry.textContent === "Download Harbor ZIP",
  );
  expect(link?.getAttribute("href")).toBe("/evaluations/exports/export-id/download");
  expect(document.body.textContent).toContain("Key works until");
  expect(document.body.textContent).toContain(
    `Tasks from the evaluation of ${new Date(evaluation.createdAt).toLocaleString()}`,
  );
  await act(async () => button("Revoke")?.click());
  expect(posts[1]?.url).toBe("/evaluations/exports/export-id/revoke");
  expect(document.body.textContent).toContain("Revoked");
  expect(document.body.textContent).not.toContain("Download Harbor ZIP");
  await act(async () => root.unmount());
});

test("customer export is disabled without a completed evaluation", async () => {
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () => root.render(<CustomerExportButton url="/evaluations" runs={[]} />));
  expect(button("Export for Customer")?.disabled).toBe(true);
  await act(async () => root.unmount());
});
