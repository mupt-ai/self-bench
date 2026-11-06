import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { hostname } from "node:os";
import { apiOrigin, requestJson } from "./api-client.js";
import { flag, parse } from "./args.js";
import { openBrowser } from "./browser.js";
import { clearConfig, readConfig, writeConfig } from "./config.js";
import {
  ansi,
  Cancelled,
  choose,
  cursor,
  grayLine,
  hintLine,
  inputDisplay,
  interactive,
  onPage,
  promptLine,
  SPINNER,
  step,
  TextInput,
  urlLines,
} from "./tui.js";

const SUBTITLE = "Sign in to the SelfBench CLI";
const DONE_PAGE = `<!doctype html><meta charset="utf-8"><title>SelfBench CLI</title>
<body style="font:15px system-ui,sans-serif;max-width:28rem;margin:15vh auto;padding:0 16px">
<h1>Signed in</h1><p>You can close this tab and return to your terminal.</p>`;

interface Callback {
  code: string;
  state: string;
}

function parseCallback(text: string): Callback {
  const url = URL.canParse(text.trim()) ? new URL(text.trim()) : undefined;
  if (!url) throw new Error("Paste the whole address from your browser's address bar.");
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) throw new Error("That URL has no sign-in code. Paste the whole address.");
  return { code, state };
}

/**
 * `login`: signs in through the browser and saves a personal API key, as the Dari CLI does. The
 * app approves the CLI and redirects to a loopback listener here; on a remote machine, paste the
 * address the browser couldn't open instead. Then picks the workspace commands default to.
 */
export async function loginCommand(args: string[]): Promise<void> {
  const { values } = parse(args, {
    "api-url": { type: "string" },
    "no-browser": { type: "boolean", default: false },
  });
  const origin = flag(values, "api-url") ?? apiOrigin();
  const verifier = randomBytes(32).toString("base64url");
  const state = randomBytes(24).toString("base64url");
  let received: (callback: Callback) => void = () => {};
  const arrived = new Promise<Callback>((resolve) => {
    received = resolve;
  });
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/callback") return response.writeHead(404).end();
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(DONE_PAGE);
    received({
      code: url.searchParams.get("code") ?? "",
      state: url.searchParams.get("state") ?? "",
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const loginUrl = `${origin}/auth/cli?${new URLSearchParams({
    callback: `http://127.0.0.1:${port}/callback`,
    state,
    challenge: createHash("sha256").update(verifier).digest("base64url"),
    name: hostname().slice(0, 60),
  })}`;
  try {
    const opened = values["no-browser"] !== true && openBrowser(loginUrl);
    const callback = interactive()
      ? await waitOnPage(loginUrl, opened, arrived)
      : await waitPlain(loginUrl, arrived);
    if (callback.state !== state)
      throw new Error("The sign-in didn't match this login. Try again.");
    const created = await exchange(origin, callback.code, verifier);
    writeConfig({
      apiUrl: origin,
      apiKey: created.secret,
      keyId: created.key.id,
      login: created.user.login,
    });
  } finally {
    server.close();
  }
  const config = readConfig();
  step(`Signed in as ${config.login}`);
  await chooseOrg();
}

async function exchange(origin: string, code: string, verifier: string) {
  const response = await fetch(new URL("/auth/cli/token", origin), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, verifier }),
  });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) throw new Error(String(body.error ?? `sign-in failed (${response.status})`));
  return body as { secret: string; key: { id: number }; user: { login: string } };
}

/** The login page: a spinner while the browser signs in, and a field for the pasted address. */
async function waitOnPage(
  url: string,
  opened: boolean,
  arrived: Promise<Callback>,
): Promise<Callback> {
  let callback: Callback | undefined;
  void arrived.then((value) => {
    callback = value;
  });
  return await onPage(SUBTITLE, async (page) => {
    const input = new TextInput();
    let problem = "";
    for (let tick = 0; ; tick += 1) {
      if (callback) return callback;
      page.render([
        promptLine("Sign in to SelfBench"),
        "",
        grayLine(
          opened
            ? "Opened your browser. Finish signing in there."
            : "Open this URL in your browser to sign in:",
        ),
        ...(opened ? ["", grayLine("If it didn't open, visit:")] : []),
        ...urlLines(url, page.width),
        "",
        `  ${ansi.coral}${SPINNER[tick % SPINNER.length]}${ansi.reset} ${ansi.gray}Waiting for your browser…${ansi.reset}`,
        "",
        cursor(true) +
          inputDisplay(input.value, page.width, "paste the callback URL (remote machines)"),
        ...(problem ? [`  ${ansi.coral}${problem}${ansi.reset}`] : []),
        hintLine("enter submit", "ctrl+c cancel"),
      ]);
      const keys = await page.keys(100);
      if (keys === undefined) continue;
      const outcome = input.feed(keys);
      if (outcome === "cancel") throw new Cancelled("login canceled");
      if (outcome !== "submit" || !input.value.trim()) continue;
      try {
        return parseCallback(input.value);
      } catch (error) {
        problem = error instanceof Error ? error.message : String(error);
        input.value = "";
      }
    }
  });
}

async function waitPlain(url: string, arrived: Promise<Callback>): Promise<Callback> {
  console.error(`Open this URL in your browser to sign in:\n${url}\nWaiting for your browser…`);
  return await arrived;
}

/** Picks the workspace commands default to: the only one, or the one chosen. */
async function chooseOrg(named?: string): Promise<void> {
  const me = await requestJson("/api/me");
  const orgs = me.orgs as { login: string; role: string; kind: string }[];
  let org = named
    ? orgs.find((entry) => entry.login.toLowerCase() === named.toLowerCase())
    : undefined;
  if (named && !org) throw new Error(`you're not in a workspace named ${named}`);
  if (!org && orgs.length === 1) org = orgs[0];
  if (!org && interactive()) {
    const index = await choose(
      "Choose your workspace",
      "Which workspace should commands use?",
      orgs.map((entry) => ({
        label: entry.login,
        note: entry.kind === "user" ? "personal" : entry.role,
      })),
      [grayLine("Change it later with self-bench org use."), ""],
    );
    org = orgs[index];
  }
  if (!org) {
    step(
      `Workspaces: ${orgs.map((entry) => entry.login).join(", ")}. Pick one with self-bench org use NAME.`,
    );
    return;
  }
  writeConfig({ ...readConfig(), org: org.login });
  step(`Workspace: ${org.login}`);
}

/** `org` shows the current workspace; `org use [NAME]` changes it. */
export async function orgCommand(args: string[]): Promise<void> {
  const [action, name] = args;
  if (action === "use") return await chooseOrg(name);
  if (action !== undefined) throw new Error("usage: self-bench org [use [NAME]]");
  const config = readConfig();
  console.log(config.org ?? "(none; run self-bench org use)");
}

/** `logout`: revokes the saved key and forgets it. */
export async function logoutCommand(): Promise<void> {
  const config = readConfig();
  if (!config.apiKey) {
    step("Not signed in.");
    return;
  }
  if (config.keyId !== undefined)
    await requestJson(`/api/api-keys/${config.keyId}`, "DELETE").catch((error: unknown) => {
      console.error(
        `Couldn't revoke the key (${error instanceof Error ? error.message : error}); revoke it under API Keys.`,
      );
    });
  clearConfig();
  step(`Signed out${config.login ? ` ${config.login}` : ""}.`);
}
