import { expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { CustomerExportButton } from "./CustomerExportDialog";
import { run } from "./results-fixture";
import { setupTrialDialogTests } from "./trial-dialog-fixture";

setupTrialDialogTests();
const button = (text: string) =>
  [...document.querySelectorAll("button")].find((entry) => entry.textContent === text);

test("customer export submits Google identity and a completed evaluation, then shows the download", async () => {
  const posts: Record<string, string>[] = [];
  const evaluation = run("12345678-1234-4234-8234-123456789abc", { status: "completed" }, []);
  let ready = false;
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    if (init?.body) {
      posts.push(JSON.parse(String(init.body)));
      ready = true;
      return Response.json({ status: "preparing" }, { status: 202 });
    }
    return Response.json({
      enabled: true,
      exports: ready
        ? [
            {
              id: "export-id",
              customer: "Acme",
              email: "customer@example.com",
              status: "ready",
              createdAt: "2026-10-01T00:00:00Z",
              repository: "us-docker.pkg.dev/project/customer-id",
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
  for (const [index, value] of ["Acme", "customer@example.com"].entries()) {
    const input = inputs[index];
    if (!input) throw new Error("Missing customer field");
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    Object.assign(input, { attachEvent() {}, detachEvent() {} });
    await act(async () => input.dispatchEvent(new window.Event("focusin", { bubbles: true })));
    await act(async () => {
      setter?.call(input, value);
      input.dispatchEvent(new window.Event("keyup", { bubbles: true }));
    });
  }
  await act(async () =>
    document
      .querySelector("form")
      ?.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })),
  );
  expect(posts[0]).toMatchObject({
    customer: "Acme",
    email: "customer@example.com",
    evaluationId: evaluation.id,
  });
  const link = [...document.querySelectorAll("a")].find(
    (entry) => entry.textContent === "Download Harbor ZIP",
  );
  expect(link?.getAttribute("href")).toBe("/evaluations/exports/export-id/download");
  expect(document.body.textContent).toContain("no automatic expiry");
  await act(async () => root.unmount());
});

test("customer export is disabled without a completed evaluation", async () => {
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () => root.render(<CustomerExportButton url="/evaluations" runs={[]} />));
  expect(button("Export for Customer")?.disabled).toBe(true);
  await act(async () => root.unmount());
});
