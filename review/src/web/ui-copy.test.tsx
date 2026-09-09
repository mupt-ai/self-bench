import { expect, test } from "bun:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Outlet, Route, Routes } from "react-router";
import { initialEvaluation } from "../../../src/evaluation/store";
import { evaluationInput } from "../../../tests/support/evaluation-fixture";
import { CredentialsPage } from "./evaluation/CredentialsPage";
import { EvaluationPage } from "./evaluation/EvaluationPage";
import { RunPage } from "./evaluation/RunPage";
import { TokenCosts } from "./evaluation/TokenCosts";
import { LoginPage } from "./pages/LoginPage";

function renderPage(page: ReactNode) {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={["/repos/mupt-ai/self-bench"]}>
      <Routes>
        <Route element={<Outlet context={{ org: { login: "mupt-ai" }, orgs: [] }} />}>
          <Route path="repos/:owner/:name" element={page} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

test("run actions and field labels use Title Case without changing helper prose", () => {
  const html = renderPage(<RunPage />);
  for (const label of [
    "Run Dataset",
    "Manage Credentials",
    "Sandbox Credential",
    "Choose Tasks in Dataset",
    "Run Comparison",
  ]) {
    expect(html).toContain(label);
  }
  expect(html).toContain("Model and cloud sandbox usage may incur charges.");
});

test("settings and results use consistent action, section and table labels", () => {
  const settings = renderPage(<CredentialsPage />);
  expect(settings).toContain("Add Credential");
  expect(settings).toContain("Shared across mupt-ai repositories");
  expect(settings).not.toContain("Import Previous Setups");
  const results = renderPage(<EvaluationPage />);
  expect(results).toContain("Compare your runs. Inspect what the solver did.");
  expect(results).toContain("Accuracy vs. Estimated Cost");
});

test("sign-in labels preserve product spelling and short prepositions", () => {
  const html = renderPage(<LoginPage />);
  expect(html).toContain("Continue with GitHub");
  expect(html).toContain("self-bench</h1>");
  expect(html).toContain('href="/auth/github"');
  expect(html).not.toContain("Build verified coding tasks");
  expect(html).not.toContain("Continue to self-bench");
});

test("token labels use Title Case while the cost explanation stays sentence case", () => {
  const run = initialEvaluation(evaluationInput(), "user-supplied model");
  const trial = run.trials[0];
  if (!trial) throw new Error("Missing fixture trial");
  trial.tokenUsage = { input: 12, cacheRead: 4, cacheWrite: 2, output: 8 };
  const html = renderToStaticMarkup(<TokenCosts trial={trial} />);
  for (const label of [
    "Token Usage",
    "Uncached Input",
    "Cached Input",
    "Cache Writes",
    "Estimated Model Cost",
  ]) {
    expect(html).toContain(label);
  }
  expect(html).toContain("Cost unavailable: incomplete pricing or usage records.");
});
