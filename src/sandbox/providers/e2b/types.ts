import type { Sandbox, SandboxInfo, SandboxPaginator } from "e2b";

export type E2BSandboxHandle = Pick<
  Sandbox,
  "sandboxId" | "commands" | "files" | "getInfo" | "kill"
>;

export interface E2BSandboxApi {
  create(
    template: string,
    options: Parameters<typeof Sandbox.create>[1],
  ): Promise<E2BSandboxHandle>;
  getInfo(sandboxId: string, options?: Parameters<typeof Sandbox.getInfo>[1]): Promise<SandboxInfo>;
  kill(sandboxId: string, options?: Parameters<typeof Sandbox.kill>[1]): Promise<boolean>;
  list(
    options?: Parameters<typeof Sandbox.list>[0],
  ): Pick<SandboxPaginator, "hasNext" | "nextItems">;
}
