#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { compileSubmittedTask, TaskCompilerInfrastructureError } from "../task-compiler.js";

try {
  const input = JSON.parse(await readFile("/work/input.json", "utf8"));
  const bundle = await compileSubmittedTask({
    taskId: input.taskId,
    repositoryUrl: input.repositoryUrl,
    definitionBytes: await readFile("/work/definition.json"),
    sourceBundle: await readFile("/work/source-task.tar.gz"),
    ...(process.env.GH_TOKEN ? { token: process.env.GH_TOKEN } : {}),
  });
  await writeFile("/work/compiled.tar.gz", bundle);
  await writeFile("/work/result.json", JSON.stringify({ ok: true }));
} catch (error) {
  await writeFile("/work/compiled.tar.gz", Buffer.alloc(0));
  const message = error instanceof Error ? error.message : "Task compilation failed";
  await writeFile(
    "/work/result.json",
    JSON.stringify({
      ok: false,
      infrastructure: error instanceof TaskCompilerInfrastructureError,
      message: process.env.GH_TOKEN
        ? message.replaceAll(process.env.GH_TOKEN, "[redacted]")
        : message,
    }),
  );
}
