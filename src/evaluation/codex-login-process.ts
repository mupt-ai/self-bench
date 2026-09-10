import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

export interface CodexDeviceCode {
  verificationUrl: string;
  userCode: string;
}
export interface CodexLoginProcess {
  instructions: Promise<CodexDeviceCode>;
  auth: Promise<string>;
  close(): Promise<void>;
}

/** Only the authentication RPCs run here. Each attempt has its own private Codex home. */
export async function startCodexLogin(): Promise<CodexLoginProcess> {
  const directory = await mkdtemp(join(tmpdir(), "selfbench-codex-login-"));
  let executable: string;
  try {
    executable = createRequire(import.meta.url).resolve("@openai/codex/bin/codex.js");
  } catch {
    await rm(directory, { recursive: true, force: true });
    throw new Error("Codex sign-in is unavailable on this server. Import an auth file instead.");
  }
  const child = spawn(
    process.execPath,
    [executable, "app-server", "-c", 'cli_auth_credentials_store="file"'],
    {
      cwd: directory,
      env: {
        PATH: process.env.PATH,
        CODEX_HOME: directory,
        ...(process.env.SSL_CERT_FILE ? { SSL_CERT_FILE: process.env.SSL_CERT_FILE } : {}),
        ...(process.env.CODEX_CA_CERTIFICATE
          ? { CODEX_CA_CERTIFICATE: process.env.CODEX_CA_CERTIFICATE }
          : {}),
      },
      stdio: ["pipe", "pipe", "ignore"],
    },
  );
  let resolveInstructions!: (value: CodexDeviceCode) => void;
  let rejectInstructions!: (error: Error) => void;
  let resolveAuth!: (value: string) => void;
  let rejectAuth!: (error: Error) => void;
  const instructions = new Promise<CodexDeviceCode>((resolve, reject) => {
    resolveInstructions = resolve;
    rejectInstructions = reject;
  });
  const auth = new Promise<string>((resolve, reject) => {
    resolveAuth = resolve;
    rejectAuth = reject;
  });
  // Callers can await instructions before auth without an unhandled rejection.
  void instructions.catch(() => undefined);
  void auth.catch(() => undefined);
  let closed: Promise<void> | undefined;
  const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
  const lines = createInterface({ input: child.stdout });
  const fail = (message: string) => {
    const error = new Error(message);
    rejectInstructions(error);
    rejectAuth(error);
  };
  const close = () => {
    if (closed) return closed;
    closed = (async () => {
      clearTimeout(startupTimeout);
      lines.close();
      fail("Sign-in was cancelled. Start again when you’re ready.");
      child.kill("SIGTERM");
      const force = setTimeout(() => child.kill("SIGKILL"), 2_000);
      force.unref();
      await exited;
      clearTimeout(force);
      await rm(directory, { recursive: true, force: true });
    })();
    return closed;
  };
  const startupTimeout = setTimeout(() => {
    fail("Codex took too long to start. Try signing in again.");
    void close();
  }, 30_000);
  startupTimeout.unref();
  child.once("error", () =>
    fail("Could not start Codex sign-in. Try again or import an auth file."),
  );
  child.once("close", () => fail("Codex sign-in ended. Try again or import an auth file."));
  child.stdin.on("error", () => fail("Could not communicate with Codex. Try signing in again."));
  const send = (value: object) => child.stdin.write(`${JSON.stringify(value)}\n`);
  lines.on("line", (line) => {
    try {
      const message = JSON.parse(line);
      if (message.error) {
        fail(
          "Could not start device sign-in. Check that device code login is enabled in your ChatGPT security settings, then try again.",
        );
        void close();
      } else if (message.id === 1) {
        send({ method: "initialized" });
        send({ id: 2, method: "account/login/start", params: { type: "chatgptDeviceCode" } });
      } else if (message.id === 2) {
        const result = message.result;
        if (
          result?.type !== "chatgptDeviceCode" ||
          result.verificationUrl !== "https://auth.openai.com/codex/device" ||
          typeof result.userCode !== "string"
        ) {
          fail("Codex returned unexpected sign-in instructions. Try again later.");
          void close();
          return;
        }
        clearTimeout(startupTimeout);
        resolveInstructions({ verificationUrl: result.verificationUrl, userCode: result.userCode });
      } else if (message.method === "account/login/completed") {
        if (message.params?.success) {
          void readFile(join(directory, "auth.json"), "utf8").then(resolveAuth, () =>
            rejectAuth(new Error("Could not read the completed sign-in. Try again.")),
          );
        } else fail("Sign-in was not completed. The code may have expired; try again.");
      }
    } catch {
      fail("Codex returned an invalid sign-in response. Try again.");
      void close();
    }
  });
  send({
    id: 1,
    method: "initialize",
    params: { clientInfo: { name: "selfbench", title: "SelfBench", version: "0.3.6" } },
  });
  return { instructions, auth, close };
}
