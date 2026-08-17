import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { SetupCanceledError, TerminalPrompter } from "../src/terminal-prompts.js";

describe("TerminalPrompter", () => {
  test("live-filters searchable choices by label, hint, or value", async () => {
    const { input, output, prompter } = fixture();
    const selection = prompter.search("Choose a project", [
      { value: "prj_alpha", label: "alpha" },
      { value: "prj_paid", label: "paid validation", hint: "production project" },
      { value: "prj_other", label: "other" },
    ]);

    send(input, "production\r");

    expect(await selection).toBe("prj_paid");
    const rendered = plainOutput(output);
    expect(rendered).toContain("Choose a project");
    expect(rendered).toContain("Type to filter");
    expect(rendered).toContain("paid validation");
  });

  test("supports arrow-key navigation through a scrollable choice window", async () => {
    const { input, output, prompter } = fixture();
    const choices = Array.from({ length: 12 }, (_, index) => ({
      value: `option-${index + 1}`,
      label: `Option ${index + 1}`,
    }));
    const selection = prompter.select("Choose an option", choices);

    send(input, `${"\u001b[B".repeat(9)}\r`);

    expect(await selection).toBe("option-10");
    expect(plainOutput(output)).toContain("Option 10");
  });

  test("accepts the configured default without moving the cursor", async () => {
    const { input, prompter } = fixture();
    const selection = prompter.select(
      "Choose an option",
      [
        { value: "first", label: "First" },
        { value: "recommended", label: "Recommended" },
      ],
      "recommended",
    );

    send(input, "\r");

    expect(await selection).toBe("recommended");
  });

  test("keeps text defaults and confirmation choices interactive", async () => {
    const textFixture = fixture();
    const projectName = textFixture.prompter.text("Project name", "selfbench-sandbox");
    send(textFixture.input, "\r");
    expect(await projectName).toBe("selfbench-sandbox");

    const confirmFixture = fixture();
    const confirmed = confirmFixture.prompter.confirm("Continue?", true);
    send(confirmFixture.input, "n\r");
    expect(await confirmed).toBe(false);
  });

  test("reads a secret without exposing its value or length and restores terminal state", async () => {
    const { input, output, prompter, rawModes } = fixture();
    input.pause();
    const secret = prompter.secret("Token");

    send(input, "vcp_secret\r");

    expect(await secret).toBe("vcp_secret");
    const rendered = plainOutput(output);
    expect(rendered).toContain("Token");
    expect(rendered).not.toContain("vcp_secret");
    expect(rendered).not.toContain("••••");
    expect(rawModes[0]).toBe(true);
    expect(rawModes.at(-1)).toBe(false);
    expect(input.isPaused()).toBe(true);
  });

  test("treats terminal EOF as cancellation and restores terminal state", async () => {
    const { input, prompter, rawModes } = fixture();
    const secret = prompter.secret("Token");

    setTimeout(() => input.end(), 0);

    await expect(secret).rejects.toBeInstanceOf(SetupCanceledError);
    expect(rawModes[0]).toBe(true);
    expect(rawModes.at(-1)).toBe(false);
  });

  test("treats Ctrl-C as setup cancellation", async () => {
    const { input, output, prompter, rawModes } = fixture();
    const selection = prompter.select("Choose", [{ value: "one", label: "One" }]);

    send(input, "\u0003");

    await expect(selection).rejects.toBeInstanceOf(SetupCanceledError);
    expect(plainOutput(output)).toContain("Setup canceled.");
    expect(rawModes.at(-1)).toBe(false);
  });

  test("treats Escape as setup cancellation", async () => {
    const { input, output, prompter, rawModes } = fixture();
    const selection = prompter.select("Choose", [{ value: "one", label: "One" }]);

    send(input, "\u001b");

    await expect(selection).rejects.toBeInstanceOf(SetupCanceledError);
    expect(plainOutput(output)).toContain("Setup canceled.");
    expect(rawModes.at(-1)).toBe(false);
  });

  test("rejects an empty choice set before touching the terminal", async () => {
    const { prompter, rawModes } = fixture();

    await expect(prompter.search("Choose", [])).rejects.toThrow("has no available choices");
    expect(rawModes).toEqual([]);
  });
});

function fixture(): {
  readonly input: PassThrough;
  readonly output: PassThrough;
  readonly prompter: TerminalPrompter;
  readonly rawModes: boolean[];
} {
  const input = new PassThrough();
  const output = new PassThrough();
  const rawModes: boolean[] = [];
  const ttyInput = Object.assign(input, {
    isTTY: true,
    isRaw: false,
    setRawMode(value: boolean) {
      this.isRaw = value;
      rawModes.push(value);
      return this;
    },
  });
  const ttyOutput = Object.assign(output, {
    isTTY: true,
    columns: 80,
    rows: 12,
  });
  return {
    input,
    output,
    prompter: new TerminalPrompter(
      ttyInput as unknown as NodeJS.ReadStream,
      ttyOutput as unknown as NodeJS.WriteStream,
    ),
    rawModes,
  };
}

function send(input: PassThrough, keys: string): void {
  setTimeout(() => input.write(keys), 0);
}

function plainOutput(output: PassThrough): string {
  return stripVTControlCharacters(output.read()?.toString() ?? "");
}
