/**
 * Full-screen prompts, as the Dari CLI draws them (dari-cli internal/cli/agent_tui.go): each
 * prompt takes over the terminal's alternate screen under a header box, and once answered the
 * terminal returns to its normal screen with a one-line ✓ summary.
 */

export const ansi = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  coral: "\x1b[38;5;209m",
  cyan: "\x1b[38;5;117m",
  green: "\x1b[38;5;114m",
  gray: "\x1b[38;5;245m",
  red: "\x1b[38;5;203m",
};

const MARGIN = "  ";
export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Whether prompts can draw: both the keyboard and the screen are a terminal. */
export const interactive = () => process.stdin.isTTY === true && process.stderr.isTTY === true;

/** A finished step, kept on the normal screen. */
export function step(text: string): void {
  console.error(interactive() ? `${ansi.green}✓${ansi.reset} ${text}` : text);
}

export const promptLine = (prompt: string) =>
  `${ansi.coral}◆${ansi.reset} ${ansi.bold}${prompt}${ansi.reset}`;
export const hintLine = (...hints: string[]) => `  ${ansi.gray}${hints.join(" · ")}${ansi.reset}`;
export const grayLine = (text: string) => `  ${ansi.gray}${text}${ansi.reset}`;
export const cursor = (active: boolean) => (active ? `${ansi.coral}❯ ${ansi.reset}` : "  ");

/** Printable cells, skipping escape sequences and hyperlinks. */
function visibleWidth(text: string): number {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: strips terminal escapes
  return text.replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, "").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").length;
}

/** The box at the top of every page, centered. */
function pageHeader(width: number, subtitle: string): string[] {
  const title = `${ansi.coral}◆${ansi.reset} ${ansi.bold}selfbench${ansi.reset}`;
  const sub = `${ansi.gray}${subtitle}${ansi.reset}`;
  const inner = Math.max(visibleWidth(title), visibleWidth(sub)) + 4;
  const row = (text: string) => {
    const pad = inner - visibleWidth(text);
    const left = Math.floor(pad / 2);
    return `${ansi.gray}│${ansi.reset}${" ".repeat(left)}${text}${" ".repeat(pad - left)}${ansi.gray}│${ansi.reset}`;
  };
  const indent = " ".repeat(Math.max(width - inner - 2, 0) >> 1);
  return [
    `${indent}${ansi.gray}╭${"─".repeat(inner)}╮${ansi.reset}`,
    indent + row(title),
    indent + row(sub),
    `${indent}${ansi.gray}╰${"─".repeat(inner)}╯${ansi.reset}`,
    "",
  ];
}

/** A URL wrapped inside the page's indent; every piece links to the whole URL. */
export function urlLines(url: string, width: number): string[] {
  const per = Math.max(width - 3, 20);
  const pieces: string[] = [];
  for (let rest = url; rest; ) {
    if (rest.length <= per) {
      pieces.push(rest);
      break;
    }
    let cut = rest.slice(0, per + 1).lastIndexOf("&");
    if (cut <= 0) cut = per;
    pieces.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  return pieces.map(
    (piece) => `  \x1b]8;;${url}\x1b\\${ansi.cyan}${piece}${ansi.reset}\x1b]8;;\x1b\\`,
  );
}

export function inputDisplay(value: string, width: number, placeholder: string): string {
  if (!value) return `${ansi.dim}${placeholder.slice(0, Math.max(width - 6, 10))}${ansi.reset}`;
  const room = width - 6;
  return room > 0 && value.length > room
    ? `${ansi.gray}…${ansi.reset}${ansi.cyan}${value.slice(value.length - room + 1)}${ansi.reset}`
    : `${ansi.cyan}${value}${ansi.reset}`;
}

function secretDisplay(value: string, width: number): string {
  if (!value) return `${ansi.dim}Paste the secret${ansi.reset}`;
  return `${ansi.cyan}${"•".repeat(Math.min(value.length, Math.max(width - 6, 8)))}${ansi.reset}`;
}

/** Typed text, with backspace; reports enter, ctrl+c, and a lone esc. */
export class TextInput {
  value = "";
  feed(chunk: string): "submit" | "cancel" | "back" | undefined {
    if (chunk === "\x1b") return "back";
    // biome-ignore lint/suspicious/noControlCharactersInRegex: drops arrow keys and other sequences
    for (const char of chunk.replace(/\x1b\[[0-9;?]*[A-Za-z~]/g, "")) {
      if (char === "\r" || char === "\n") return "submit";
      if (char === "\x03") return "cancel";
      if (char === "\x7f" || char === "\b") this.value = this.value.slice(0, -1);
      else if (char >= " " && char <= "~") this.value += char;
    }
    return undefined;
  }
}

export class Cancelled extends Error {
  constructor(what = "canceled") {
    super(what);
  }
}

/** One page on the alternate screen, in raw mode, until `close`. */
export class Page {
  readonly width: number;
  private readonly chunks: string[] = [];
  private waiting: (() => void) | undefined;
  private readonly onData = (data: Buffer) => {
    this.chunks.push(data.toString("utf8"));
    this.waiting?.();
  };

  constructor(private readonly subtitle: string) {
    this.width = (process.stderr.columns ?? 80) - MARGIN.length;
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", this.onData);
    process.stderr.write("\x1b[?1049h\x1b[?25l");
  }

  render(lines: string[]): void {
    let frame = "\x1b[H\x1b[K\r\n";
    for (const line of [...pageHeader(this.width, this.subtitle), ...lines])
      frame += `${MARGIN}${line}${ansi.reset}\x1b[K\r\n`;
    process.stderr.write(`${frame}\x1b[J`);
  }

  /** The next keys typed, or undefined after `ms` without any. */
  async keys(ms?: number): Promise<string | undefined> {
    if (!this.chunks.length)
      await new Promise<void>((resolve) => {
        this.waiting = resolve;
        if (ms !== undefined) setTimeout(resolve, ms);
      });
    this.waiting = undefined;
    return this.chunks.length ? this.chunks.splice(0).join("") : undefined;
  }

  close(): void {
    process.stdin.off("data", this.onData);
    process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stderr.write("\x1b[?25h\x1b[?1049l");
  }
}

/** Runs `body` on a page, always restoring the terminal. */
export async function onPage<T>(subtitle: string, body: (page: Page) => Promise<T>): Promise<T> {
  const page = new Page(subtitle);
  try {
    return await body(page);
  } finally {
    page.close();
  }
}

export interface Choice {
  label: string;
  note?: string;
  description?: string;
}

/** One question: arrows or j/k move, enter or a number picks, esc or q cancels. */
export async function choose(
  subtitle: string,
  prompt: string,
  choices: Choice[],
  details: string[] = [],
) {
  return await onPage(subtitle, async (page) => {
    let at = 0;
    for (;;) {
      const lines = [promptLine(prompt), ...details];
      choices.forEach((choice, index) => {
        const label = `${index + 1}. ${choice.label}`;
        let line =
          cursor(index === at) + (index === at ? `${ansi.bold}${label}${ansi.reset}` : label);
        if (choice.note) line += `  ${ansi.green}${choice.note}${ansi.reset}`;
        lines.push(line);
        if (choice.description) lines.push(`     ${ansi.gray}${choice.description}${ansi.reset}`);
      });
      page.render([...lines, hintLine("↑↓ move", "enter confirm", "esc cancel")]);
      const keys = (await page.keys()) ?? "";
      if (keys === "\x1b[A" || keys === "k") at = (at - 1 + choices.length) % choices.length;
      else if (keys === "\x1b[B" || keys === "j") at = (at + 1) % choices.length;
      else if (keys === "\r" || keys === "\n") return at;
      else if (keys === "\x1b" || keys === "q" || keys === "\x03") throw new Cancelled();
      else if (/^[1-9]$/.test(keys) && Number(keys) <= choices.length) return Number(keys) - 1;
    }
  });
}

/**
 * Reads text (or a secret, masked) on a page. `submit` may refuse it with an error, shown for
 * another try. Esc returns undefined.
 */
export async function ask(
  subtitle: string,
  prompt: string,
  options: {
    details?: string[];
    secret?: boolean;
    placeholder?: string;
    /** What an empty enter means; without it, a value is required. */
    fallback?: string;
    submit?: (value: string) => Promise<void>;
  },
): Promise<string | undefined> {
  return await onPage(subtitle, async (page) => {
    const input = new TextInput();
    let status = "";
    for (;;) {
      const field = options.secret
        ? secretDisplay(input.value, page.width)
        : inputDisplay(input.value, page.width, options.placeholder ?? "");
      page.render([
        promptLine(prompt),
        ...(options.details ?? []),
        ...(options.details?.length ? [""] : []),
        cursor(true) + field,
        ...(status ? [`  ${ansi.red}${status}${ansi.reset}`] : []),
        hintLine("enter confirm", "esc back"),
      ]);
      const outcome = input.feed((await page.keys()) ?? "");
      if (outcome === "cancel") throw new Cancelled();
      if (outcome === "back") return undefined;
      if (outcome !== "submit") continue;
      const value = input.value.trim() || options.fallback || "";
      if (!value) {
        status = "Type a value, or press esc to go back.";
        continue;
      }
      try {
        await options.submit?.(value);
        return value;
      } catch (error) {
        status = error instanceof Error ? error.message : String(error);
      }
    }
  });
}
