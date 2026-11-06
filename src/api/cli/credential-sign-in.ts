import { requestJson } from "./api-client.js";
import { openBrowser } from "./browser.js";
import {
  ansi,
  Cancelled,
  cursor,
  grayLine,
  hintLine,
  inputDisplay,
  interactive,
  onPage,
  promptLine,
  SPINNER,
  TextInput,
  urlLines,
} from "./tui.js";

const SUBTITLE = "Connect a credential";

interface LoginState {
  id: string;
  status: "waiting" | "saved" | "failed";
  error?: string;
  credential?: Record<string, unknown>;
  authorizeUrl?: string;
  instructions?: { verificationUrl: string; userCode: string };
}

/** A provider sign-in, run by the server; the CLI shows its code or takes the pasted one. */
export async function signIn(
  base: string,
  auth: "codex-login" | "claude-login" | "muse-login",
  label: string,
  name: string,
): Promise<Record<string, unknown>> {
  const path = `${base}/${auth}`;
  const started = (await requestJson(path, "POST", { name })) as unknown as LoginState;
  const login = `${path}/${encodeURIComponent(started.id)}`;
  if (auth === "claude-login") {
    const url = started.authorizeUrl ?? "";
    if (!interactive()) {
      console.error(`Open ${url}\nthen run: self-bench credential complete ${started.id} CODE`);
      return { id: started.id, status: "waiting", authorizeUrl: url };
    }
    const code = await pasteCode(label, url);
    if (!code) throw new Cancelled();
    return finished(
      (await requestJson(`${login}/complete`, "POST", { code })) as unknown as LoginState,
    );
  }
  const { verificationUrl = "", userCode = "" } = started.instructions ?? {};
  const poll = async () => (await requestJson(login)) as unknown as LoginState;
  if (!interactive()) {
    console.error(`Open ${verificationUrl} and enter ${userCode}. Waiting…`);
    for (;;) {
      const state = await poll();
      if (state.status !== "waiting") return finished(state);
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
  return finished(await deviceCodePage(label, verificationUrl, userCode, poll, login));
}

function finished(state: LoginState): Record<string, unknown> {
  if (state.status !== "saved") throw new Error(state.error ?? "the sign-in didn't finish");
  return state.credential ?? {};
}

/** Shows the device code and checks every few seconds until the provider approves it. */
async function deviceCodePage(
  label: string,
  url: string,
  code: string,
  poll: () => Promise<LoginState>,
  login: string,
): Promise<LoginState> {
  return await onPage(SUBTITLE, async (page) => {
    for (let tick = 0; ; tick += 1) {
      page.render([
        promptLine(`Connect ${label}`),
        grayLine("Open this URL and sign in:"),
        ...urlLines(url, page.width),
        "",
        `  Enter this code:  ${ansi.coral}${ansi.bold}${code}${ansi.reset}`,
        "",
        `  ${ansi.coral}${SPINNER[tick % SPINNER.length]}${ansi.reset} ${ansi.gray}Waiting for approval…${ansi.reset}`,
        hintLine("ctrl+c cancel"),
      ]);
      const keys = await page.keys(150);
      if (keys?.includes("\x03") || keys === "\x1b") {
        await requestJson(`${login}/cancel`, "POST").catch(() => undefined);
        throw new Cancelled(`${label} canceled`);
      }
      if (tick % 20 === 19) {
        const state = await poll();
        if (state.status !== "waiting") return state;
      }
    }
  });
}

/** Opens the provider's page and takes the code it shows after approval. */
async function pasteCode(label: string, url: string): Promise<string | undefined> {
  openBrowser(url);
  return await onPage(SUBTITLE, async (page) => {
    const input = new TextInput();
    for (;;) {
      page.render([
        promptLine(`Connect ${label}`),
        grayLine("Opened your browser. If it didn't open, visit:"),
        ...urlLines(url, page.width),
        "",
        "  Paste the code shown after you approve:",
        cursor(true) + inputDisplay(input.value, page.width, "code#state"),
        hintLine("enter submit", "esc back"),
      ]);
      const outcome = input.feed((await page.keys()) ?? "");
      if (outcome === "cancel") throw new Cancelled();
      if (outcome === "back") return undefined;
      if (outcome === "submit" && input.value.trim()) return input.value.trim();
    }
  });
}
