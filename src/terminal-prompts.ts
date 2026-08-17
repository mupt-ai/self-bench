import {
  autocomplete,
  cancel as cancelPrompt,
  confirm as confirmPrompt,
  isCancel,
  password,
  select as selectPrompt,
  text as textPrompt,
} from "@clack/prompts";

export class SetupCanceledError extends Error {
  constructor(message = "Setup canceled") {
    super(message);
    this.name = "SetupCanceledError";
  }
}

export interface PromptChoice {
  readonly value: string;
  readonly label: string;
  readonly hint?: string;
}

export interface SetupPrompter {
  select(message: string, choices: readonly PromptChoice[], defaultValue?: string): Promise<string>;
  search(message: string, choices: readonly PromptChoice[], defaultValue?: string): Promise<string>;
  text(message: string, defaultValue?: string): Promise<string>;
  secret(message: string): Promise<string>;
  confirm(message: string, defaultValue: boolean): Promise<boolean>;
}

export class TerminalPrompter implements SetupPrompter {
  readonly #input: NodeJS.ReadStream;
  readonly #output: NodeJS.WriteStream;

  constructor(
    input: NodeJS.ReadStream = process.stdin,
    output: NodeJS.WriteStream = process.stdout,
  ) {
    this.#input = input;
    this.#output = output;
  }

  async select(
    message: string,
    choices: readonly PromptChoice[],
    defaultValue?: string,
  ): Promise<string> {
    this.#assertChoices(message, choices);
    return await this.#run((signal) =>
      selectPrompt<string>({
        message,
        options: choices.map(toPromptOption),
        maxItems: this.#visibleItemCount(),
        showInstructions: true,
        ...(defaultValue !== undefined && choices.some(({ value }) => value === defaultValue)
          ? { initialValue: defaultValue }
          : {}),
        input: this.#input,
        output: this.#output,
        signal,
      }),
    );
  }

  async search(
    message: string,
    choices: readonly PromptChoice[],
    defaultValue?: string,
  ): Promise<string> {
    this.#assertChoices(message, choices);
    return await this.#run((signal) =>
      autocomplete<string>({
        message,
        options: choices.map(toPromptOption),
        placeholder: "Type to filter…",
        maxItems: this.#visibleItemCount(),
        filter: (query, option) =>
          `${option.label ?? ""}\n${option.hint ?? ""}\n${option.value}`
            .toLowerCase()
            .includes(query.toLowerCase()),
        ...(defaultValue !== undefined && choices.some(({ value }) => value === defaultValue)
          ? { initialValue: defaultValue }
          : {}),
        input: this.#input,
        output: this.#output,
        signal,
      }),
    );
  }

  async text(message: string, defaultValue?: string): Promise<string> {
    return await this.#run((signal) =>
      textPrompt({
        message,
        ...(defaultValue === undefined ? {} : { placeholder: defaultValue, defaultValue }),
        input: this.#input,
        output: this.#output,
        signal,
      }),
    );
  }

  async secret(message: string): Promise<string> {
    if (!this.#input.isTTY || !this.#input.setRawMode) {
      throw new Error("secure token input requires an interactive terminal");
    }
    return await this.#run((signal) =>
      password({
        message,
        // An empty mask keeps both the token and its length out of terminal output.
        mask: "",
        validate: (value) => (value?.trim() ? undefined : "Enter a project-scoped token."),
        input: this.#input,
        output: this.#output,
        signal,
      }),
    );
  }

  async confirm(message: string, defaultValue: boolean): Promise<boolean> {
    return await this.#run((signal) =>
      confirmPrompt({
        message,
        initialValue: defaultValue,
        input: this.#input,
        output: this.#output,
        signal,
      }),
    );
  }

  async #run<T>(prompt: (signal: AbortSignal) => Promise<T | symbol>): Promise<T> {
    const controller = new AbortController();
    const wasRaw = this.#input.isRaw;
    const wasFlowing = this.#input.readableFlowing;
    let inputFailure: Error | undefined;
    const abort = (error: Error): void => {
      inputFailure = error;
      controller.abort(error);
    };
    const onEnd = (): void => abort(new SetupCanceledError("Setup canceled at end of input"));
    const onError = (error: Error): void => abort(error);
    this.#input.once("end", onEnd);
    this.#input.once("error", onError);
    if (this.#input.readableEnded) {
      onEnd();
    }

    try {
      const result = await prompt(controller.signal);
      if (isCancel(result)) {
        const error = inputFailure ?? new SetupCanceledError();
        if (error instanceof SetupCanceledError) {
          cancelPrompt("Setup canceled.", { output: this.#output, withGuide: true });
        }
        throw error;
      }
      return result;
    } finally {
      this.#input.off("end", onEnd);
      this.#input.off("error", onError);
      if (this.#input.isTTY && this.#input.setRawMode && this.#input.isRaw !== wasRaw) {
        this.#input.setRawMode(Boolean(wasRaw));
      }
      if (wasFlowing !== true) {
        this.#input.pause();
      }
    }
  }

  #assertChoices(message: string, choices: readonly PromptChoice[]): void {
    if (choices.length === 0) {
      throw new Error(`${message} has no available choices`);
    }
  }

  #visibleItemCount(): number {
    return Math.max(3, Math.min(8, (this.#output.rows ?? 20) - 6));
  }
}

export function isInteractiveTerminal(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

function toPromptOption(choice: PromptChoice): {
  readonly value: string;
  readonly label: string;
  readonly hint?: string;
} {
  return {
    value: choice.value,
    label: choice.label,
    ...(choice.hint ? { hint: choice.hint } : {}),
  };
}
