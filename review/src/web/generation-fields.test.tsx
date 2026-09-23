import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import {
  executionBackendLabels,
  HOSTED_EXECUTION_BACKENDS,
} from "../../../src/contracts/config/providers";
import type { CredentialInfo } from "../../../src/evaluation/account";
import type { GenerationSettings } from "../../../src/generation/settings/settings";
import { CredentialEditor } from "./evaluation/CredentialEditor";
import { credentialProvider, isSandbox } from "./evaluation/credential-presentation";
import { GenerationFields } from "./GenerationFields";
import { generationSelectionProblem, generationSettingsSummary } from "./generation-defaults";

const credentials: CredentialInfo[] = ["openai", "modal", "e2b", "vercel", "daytona"].map(
  (kind) => ({
    id: crypto.randomUUID(),
    name: `${kind}-credential`,
    kind: kind as CredentialInfo["kind"],
    auth: "api-key",
    createdAt: "2026-09-09",
  }),
);
const base: GenerationSettings = {
  authorModel: "gpt-5.6-sol",
  verifierModel: "gpt-6-astra",
  reasoning: "high",
  modelAccess: "credential",
  sandbox: "modal",
  modelCredentialId: credentials[0]?.id ?? "",
  sandboxCredentialId: credentials[1]?.id,
};
function render(value: GenerationSettings, sandboxes = [...HOSTED_EXECUTION_BACKENDS]) {
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
  for (const sandbox of HOSTED_EXECUTION_BACKENDS)
    expect(html).toContain(`>${executionBackendLabels[sandbox]}</option>`);
  expect(html).not.toContain('value="docker"');
  expect(html).not.toContain('value="managed"');
  const modalOnly = render(base, ["modal"]);
  expect(
    modalOnly.match(/<select[^>]+id="generation-sandbox"[\s\S]*?<\/select>/)?.[0],
  ).not.toContain('value="vercel"');
});

test("managed model access and sandbox are offered only when the deployment flags them", () => {
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <GenerationFields
        value={{
          ...base,
          modelAccess: "managed",
          modelCredentialId: undefined,
          sandbox: "managed",
          sandboxCredentialId: undefined,
        }}
        options={{
          available: true,
          sandboxes: [...HOSTED_EXECUTION_BACKENDS],
          models: [base.authorModel, base.verifierModel],
          credentials,
          managed: { models: true, sandbox: true },
        }}
        disabled={false}
        onChange={() => {}}
      />
    </MemoryRouter>,
  );
  expect(html).toContain('value="managed"');
  expect(html).toContain(">Managed</option>");
  expect(html).toContain("Generation");
  expect(html).toContain("GPT-5.6 Sol / GPT-6 Astra · High Reasoning · Managed");
  expect(html).not.toContain("Model Credential");
  expect(html).not.toContain("both authors and verifies");
});

test("managed capabilities are gated independently by the deployment's keys", () => {
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <GenerationFields
        value={{ ...base, sandbox: "managed", sandboxCredentialId: undefined }}
        options={{
          available: true,
          sandboxes: [...HOSTED_EXECUTION_BACKENDS],
          models: [base.authorModel, base.verifierModel],
          credentials,
          managed: { models: false, sandbox: true },
        }}
        disabled={false}
        onChange={() => {}}
      />
    </MemoryRouter>,
  );
  // Only the sandbox's managed option appears; the model-access select offers no managed
  // entry, and the credential select appears because the offer cannot serve the models.
  expect(html).not.toContain('<option value="managed">Managed</option>');
  expect(html).toContain('value="credential" selected');
  expect(html).toContain("Model Credential");
  expect(html).toContain('<option value="managed" selected="">Managed</option>');
});

test("collapsed generation summary is a short fact line", () => {
  expect(
    generationSettingsSummary({
      authorModel: "gpt-5.6-sol",
      verifierModel: "gpt-5.6-sol",
      reasoning: "high",
      modelAccess: "managed",
      sandbox: "managed",
    }),
  ).toBe("GPT-5.6 Sol · High Reasoning · Managed");
  expect(
    generationSettingsSummary({
      authorModel: "gpt-5.6-sol",
      verifierModel: "gpt-6-astra",
      reasoning: "medium",
      modelAccess: "credential",
      sandbox: "modal",
    }),
  ).toBe("GPT-5.6 Sol / GPT-6 Astra · Medium Reasoning · My Credentials · Modal");
});

test.each(["modal", "e2b", "vercel"] as const)(
  "%s generation exposes separate Harbor settings with only matching credentials",
  (sandbox) => {
    const html = render({ ...base, sandbox, sandboxCredentialId: undefined });
    if (sandbox === "vercel") expect(html).toContain("Vercel Runtime Image");
    else expect(html).not.toContain("E2B Template");
    expect(html).toContain("Harbor Verification");
    expect(html).not.toContain('value="docker"');
    for (const environment of ["modal", "vercel", "e2b", "daytona"])
      expect(html).toContain(`value="${environment}"`);
    expect(html).toContain(`${sandbox}-credential`);
    expect(html).not.toContain(`${sandbox === "e2b" ? "vercel" : "e2b"}-credential`);
    if (sandbox !== "modal") expect(html).not.toContain("modal-credential");
    expect(html).not.toContain("daytona-credential");
    const modal = render({ ...base, sandbox, harborEnvironment: "modal" });
    expect(modal).toContain("Harbor Modal Credential");
    expect(modal).toContain("modal-credential");
    const daytona = render({ ...base, sandbox, harborEnvironment: "daytona" });
    expect(daytona).toContain("Harbor Daytona Credential");
    expect(daytona).toContain("daytona-credential");
    if (sandbox !== "modal") expect(daytona).not.toContain("modal-credential");
  },
);

test("Modal generation exposes separate Harbor settings", () => {
  const modal = render({ ...base, harborEnvironment: "modal", harborCredentialId: undefined });
  expect(modal).toContain("Modal Credential");
  expect(modal).toContain("modal-credential");
  expect(modal).toContain("Harbor Verification");
  expect(modal).toContain("Harbor Modal Credential");
});

test("generation popup keeps helper descriptions in tooltips", () => {
  const html = render({ ...base, sandbox: "e2b", sandboxCredentialId: undefined });
  // Tooltips are Radix (shadcn) triggers; the hint is the trigger's accessible label.
  expect(html).toContain('aria-label="Managed runs on SelfBench');
  expect(html).toContain('aria-label="Managed sandboxes run on SelfBench');
  expect(html).toContain(
    'aria-label="Each PR starts a separate workflow. Managed model and sandbox usage is tracked per run',
  );
  expect(html).toContain(
    'aria-label="Generation runs in E2B; Harbor verification runs in your Modal, Vercel, E2B, Daytona account."',
  );
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

test("managed generation cannot be submitted until billing is eligible", () => {
  const value: GenerationSettings = {
    ...base,
    modelAccess: "managed",
    modelCredentialId: undefined,
    sandbox: "managed",
    sandboxCredentialId: undefined,
  };
  const options = {
    available: true,
    sandboxes: [...HOSTED_EXECUTION_BACKENDS],
    models: [base.authorModel, base.verifierModel],
    credentials,
    managed: { models: true, sandbox: true },
  };
  expect(generationSelectionProblem(value, options)).toBeUndefined();
  expect(
    generationSelectionProblem(value, {
      ...options,
      billing: { configured: true, eligible: false },
    }),
  ).toBe("Set up billing to use managed models or sandboxes.");
  expect(
    generationSelectionProblem(
      {
        ...base,
        sandbox: "modal",
        harborEnvironment: "modal",
        harborCredentialId: credentials[1]?.id,
      },
      { ...options, billing: { configured: true, eligible: false } },
    ),
  ).toBeUndefined();
});
