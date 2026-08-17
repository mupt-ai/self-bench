import type { Writable } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { cancel as cancelPrompt, intro, log, outro, spinner } from "@clack/prompts";
import { type CommandOutputHandler, RollingOutput } from "./process.js";
import { SetupCanceledError } from "./terminal-prompts.js";

export interface SetupTaskLabels {
  readonly pending: string;
  readonly success: string;
  readonly failure: string;
}

export interface SetupReporter {
  intro(title: string): void;
  message(message: string): void;
  warn(message: string): void;
  cancel(message: string): void;
  task<T>(
    labels: SetupTaskLabels,
    operation: (onOutput: CommandOutputHandler) => Promise<T>,
  ): Promise<T>;
  finish(title: string, details: readonly string[]): void;
}

export class TerminalSetupReporter implements SetupReporter {
  readonly #output: Writable;
  readonly #errorOutput: Writable;
  readonly #verbose: boolean;

  constructor(
    options: {
      readonly output?: Writable;
      readonly errorOutput?: Writable;
      readonly verbose?: boolean;
    } = {},
  ) {
    this.#output = options.output ?? process.stdout;
    this.#errorOutput = options.errorOutput ?? process.stderr;
    this.#verbose = options.verbose ?? false;
  }

  intro(title: string): void {
    intro(title, { output: this.#output, withGuide: true });
  }

  message(message: string): void {
    log.message(message, { output: this.#output, withGuide: true });
  }

  warn(message: string): void {
    log.warn(message, { output: this.#output, withGuide: true });
  }

  cancel(message: string): void {
    cancelPrompt(message, { output: this.#output, withGuide: true });
  }

  async task<T>(
    labels: SetupTaskLabels,
    operation: (onOutput: CommandOutputHandler) => Promise<T>,
  ): Promise<T> {
    const captured = new RollingOutput();
    const onOutput: CommandOutputHandler = (stream, chunk) => {
      captured.push(Buffer.from(chunk));
      if (this.#verbose) {
        (stream === "stderr" ? this.#errorOutput : this.#output).write(chunk);
      }
    };

    if (this.#verbose) {
      log.step(labels.pending, { output: this.#output, withGuide: true });
      try {
        const result = await operation(onOutput);
        log.success(labels.success, { output: this.#output, withGuide: true });
        return result;
      } catch (error) {
        if (error instanceof SetupCanceledError) {
          this.cancel("Setup canceled.");
          throw error;
        }
        log.error(labels.failure, { output: this.#output, withGuide: true });
        throw error;
      }
    }

    const progress = spinner({ indicator: "timer", output: this.#output, withGuide: true });
    progress.start(labels.pending);
    try {
      const result = await operation(onOutput);
      progress.stop(labels.success);
      return result;
    } catch (error) {
      if (error instanceof SetupCanceledError) {
        progress.cancel("Setup canceled.");
        throw error;
      }
      progress.error(labels.failure);
      this.#showFailureOutput(captured.text());
      throw error;
    }
  }

  finish(title: string, details: readonly string[]): void {
    log.success(title, { output: this.#output, withGuide: true });
    log.message([...details], {
      output: this.#output,
      spacing: 0,
      withGuide: true,
    });
    outro("Vercel Sandbox is ready.", { output: this.#output, withGuide: true });
  }

  #showFailureOutput(value: string): void {
    const cleaned = stripVTControlCharacters(value)
      .replace(/\r(?!\n)/g, "\n")
      .trim();
    if (!cleaned) {
      return;
    }
    log.message(["Command output:", ...cleaned.split("\n")], {
      output: this.#output,
      spacing: 0,
      withGuide: true,
    });
  }
}
