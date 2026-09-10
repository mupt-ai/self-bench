import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import type { CredentialInfo } from "../../../src/evaluation/account";
import { EXECUTION_BACKENDS, executionBackendLabels } from "../../../src/providers";
import type { GenerationSettings } from "../../../src/site/generation-settings";
import { CredentialEditor } from "./evaluation/CredentialEditor";
import { credentialProvider, isSandbox } from "./evaluation/credential-presentation";
import { GenerationFields } from "./GenerationFields";

const credentials: CredentialInfo[] = ["openai", "modal", "e2b", "vercel"].map((kind) => ({
  id: crypto.randomUUID(),
  name: `${kind}-credential`,
  kind: kind as CredentialInfo["kind"],
  auth: "api-key",
  createdAt: "2026-09-09",
}));
const base: GenerationSettings = {
  authorModel: "gpt-5.6-sol",
  verifierModel: "gpt-6-astra",
  reasoning: "high",
  sandbox: "docker",
  modelCredentialId: credentials[0]?.id ?? "",
};
function render(value: GenerationSettings, sandboxes = [...EXECUTION_BACKENDS]) {
  return renderToStaticMarkup(
    <MemoryRouter>
      <GenerationFields
        value={value}
        options={{
          available: true,
          sandboxes,
          models: [base.authorModel, base.verifierModel],
          credentials,
        }}
        disabled={false}
        onChange={() => {}}
      />
    </MemoryRouter>,
  );
}

test("generation sandbox options come from the API and use the shared provider labels", () => {
  const html = render(base);
  for (const sandbox of EXECUTION_BACKENDS)
    expect(html).toContain(`>${executionBackendLabels[sandbox]}</option>`);
  expect(render(base, ["docker"])).not.toContain('value="vercel"');
});

test.each(["e2b", "vercel"] as const)(
  "%s generation exposes runtime and separate Harbor settings with only matching credentials",
  (sandbox) => {
    const html = render({ ...base, sandbox, harborEnvironment: "docker" });
    expect(html).toContain(sandbox === "e2b" ? "E2B Template" : "Vercel Runtime Image");
    expect(html).toContain("Harbor Verification");
    expect(html).toContain(`${sandbox}-credential`);
    expect(html).not.toContain(`${sandbox === "e2b" ? "vercel" : "e2b"}-credential`);
    expect(html).not.toContain("modal-credential");
    const modal = render({ ...base, sandbox, harborEnvironment: "modal" });
    expect(modal).toContain("Harbor Modal Credential");
    expect(modal).toContain("modal-credential");
  },
);

test("Docker stays credential-free and Modal retains its existing credential selection", () => {
  expect(render(base)).not.toContain("Harbor Verification");
  expect(render(base)).not.toContain("Choose a Credential");
  const modal = render({ ...base, sandbox: "modal" });
  expect(modal).toContain("Modal Credential");
  expect(modal).not.toContain("Harbor Verification");
});

test("Vercel credential editor exposes token, team and project fields", () => {
  const html = renderToStaticMarkup(
    <CredentialEditor
      previous={credentials[3]}
      org="example-org"
      onCancel={() => {}}
      onSave={async () => {}}
      onSaved={async () => {}}
    />,
  );
  for (const label of ["Vercel Token", "Vercel Team ID", "Vercel Project ID"])
    expect(html).toContain(label);
  expect(html).not.toContain("Model API Key");
  expect(html).toContain("<dialog");
  expect(html).toContain('type="password"');
  expect(html).toContain('required="" autoComplete="off" maxLength="256"');
});

test("Vercel credentials appear in the sandbox group with the provider label", () => {
  expect(isSandbox("vercel")).toBe(true);
  expect(credentialProvider({ kind: "vercel", auth: "api-key" })).toBe("Vercel");
});
