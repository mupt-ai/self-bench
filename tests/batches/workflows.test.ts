import { expect, test } from "bun:test";
import ts from "typescript";

test("new discovery and author entrypoints contain no child starts, parent signals or GitHub I/O", async () => {
  const source = await Bun.file(new URL("../../src/temporal/workflow.ts", import.meta.url)).text();
  const file = ts.createSourceFile("workflow.ts", source, ts.ScriptTarget.Latest, true);
  for (const name of ["selfBenchDiscoveryShardWorkflow", "selfBenchAuthorWorkflow"]) {
    const declaration = file.statements.find(
      (statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === name,
    );
    expect(declaration).toBeDefined();
    const body = declaration?.getText(file) ?? "";
    expect(body).not.toMatch(
      /executeChild|startChild|parent|signal\(|fetch\(|collectRunProvenance/,
    );
  }
  const api = await Bun.file(new URL("../../src/api.ts", import.meta.url)).text();
  const site = await Bun.file(new URL("../../src/site/runtime.ts", import.meta.url)).text();
  expect(api).not.toContain("start(selfBenchRunWorkflow");
  expect(site).not.toContain("start(selfBenchRunWorkflow");
});
