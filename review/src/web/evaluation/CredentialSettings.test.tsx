import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { CredentialInfo } from "../../../../src/db/credentials";
import { EditCredentialDialog } from "./CredentialSettings";

test("Edit Credential starts from the credential's name and limits", () => {
  const edit = (credential: CredentialInfo) =>
    renderToStaticMarkup(
      <EditCredentialDialog credential={credential} onSave={async () => {}} onClose={() => {}} />,
    );
  const e2b: CredentialInfo = {
    id: "credential",
    name: "Team",
    kind: "e2b",
    auth: "api-key",
    createdAt: "2026-09-09T00:00:00Z",
    maxSandboxes: 20,
    maxBuilds: 10,
  };
  const html = edit(e2b);
  expect(html).toContain("Edit Credential");
  expect(html).toMatch(/id="edit-credential-name"[^>]*value="Team"/);
  expect(html).toMatch(/id="credential-max-sandboxes"[^>]*value="20"/);
  expect(html).toMatch(/id="credential-max-builds"[^>]*value="10"/);
  expect(edit({ ...e2b, kind: "modal" })).not.toContain("Max Concurrent Builds");
});
