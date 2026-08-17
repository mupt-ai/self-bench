import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { SetupCanceledError } from "../src/terminal-prompts.js";
import { TerminalSetupReporter } from "../src/terminal-reporter.js";

describe("TerminalSetupReporter", () => {
  test("shows a live timer and collapses successful command output", async () => {
    const output = terminalOutput();
    const reporter = new TerminalSetupReporter({ output });

    await reporter.task(
      {
        pending: "Publishing runtime image",
        success: "Runtime image published",
        failure: "Runtime image publication failed",
      },
      async (onOutput) => {
        onOutput("stdout", Buffer.from("hidden build output\n"));
        await Bun.sleep(100);
      },
    );

    const rendered = plainOutput(output);
    // Clack deliberately replaces animated timer frames with an ellipsis in CI.
    // The completed line still freezes the elapsed time in both render modes.
    if (process.env.CI === "true") {
      expect(rendered).toContain("Publishing runtime image...");
    } else {
      expect(rendered).toContain("Publishing runtime image [0s]");
    }
    expect(rendered).toContain("Runtime image published [0s]");
    expect(rendered).not.toContain("hidden build output");
  });

  test("reveals retained command output when a compact task fails", async () => {
    const output = terminalOutput();
    const reporter = new TerminalSetupReporter({ output });

    await expect(
      reporter.task(
        {
          pending: "Publishing runtime image",
          success: "Runtime image published",
          failure: "Runtime image publication failed",
        },
        async (onOutput) => {
          onOutput("stderr", Buffer.from("provider failure detail\n"));
          throw new Error("publication failed");
        },
      ),
    ).rejects.toThrow("publication failed");

    const rendered = plainOutput(output);
    expect(rendered).toContain("Runtime image publication failed [0s]");
    expect(rendered).toContain("Command output:");
    expect(rendered).toContain("provider failure detail");
  });

  test("streams subprocess output unchanged in verbose mode", async () => {
    const output = terminalOutput();
    const errorOutput = terminalOutput();
    const reporter = new TerminalSetupReporter({ output, errorOutput, verbose: true });

    await reporter.task(
      {
        pending: "Publishing runtime image",
        success: "Runtime image published",
        failure: "Runtime image publication failed",
      },
      async (onOutput) => {
        onOutput("stdout", Buffer.from("build stdout\n"));
        onOutput("stderr", Buffer.from("build stderr\n"));
      },
    );

    expect(plainOutput(output)).toContain("build stdout");
    expect(plainOutput(errorOutput)).toBe("build stderr\n");
    expect(plainOutput(output)).not.toContain("[0s]");
  });

  test("renders task cancellation without presenting it as a failure", async () => {
    const output = terminalOutput();
    const reporter = new TerminalSetupReporter({ output });

    await expect(
      reporter.task(
        {
          pending: "Verifying Sandbox access",
          success: "Sandbox access verified",
          failure: "Sandbox verification failed",
        },
        async () => {
          throw new SetupCanceledError();
        },
      ),
    ).rejects.toBeInstanceOf(SetupCanceledError);

    const rendered = plainOutput(output);
    expect(rendered).toContain("Setup canceled.");
    expect(rendered).not.toContain("Sandbox verification failed");
  });
});

function terminalOutput(): PassThrough {
  return Object.assign(new PassThrough(), {
    isTTY: true,
    columns: 100,
    rows: 20,
  });
}

function plainOutput(output: PassThrough): string {
  return stripVTControlCharacters(output.read()?.toString() ?? "");
}
