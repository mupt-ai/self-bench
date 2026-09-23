import { expect, test } from "bun:test";
import { settingLabel, vendorColor } from "./format";
import { setting } from "./test-fixture";

test("twin model labels are told apart by what differs between them", () => {
  const apiKey = setting({
    id: "sol-key",
    model: { catalogId: "sol", name: "openai/sol", label: "Sol" },
  });
  const chatgpt = setting({
    id: "sol-chatgpt",
    model: { catalogId: "sol", name: "openai/sol", label: "Sol" },
    signIn: "codex-login",
  });
  const other = setting({
    id: "luna",
    model: { catalogId: "luna", name: "openai/luna", label: "Luna" },
  });
  const all = [apiKey, chatgpt, other];
  expect(settingLabel(apiKey, all)).toBe("Sol (API Key)");
  expect(settingLabel(chatgpt, all)).toBe("Sol (ChatGPT Sign-In)");
  expect(settingLabel(other, all)).toBe("Luna");
});

test("OpenRouter models take their vendor's colour, with or without a gateway prefix", () => {
  const routed = (name: string) =>
    vendorColor(
      setting({ id: name, provider: "openrouter", model: { catalogId: "x", name, label: "X" } }),
    );
  expect(routed("z-ai/glm-5.3")).toBe(routed("openrouter/z-ai/glm-5.3"));
  expect(routed("z-ai/glm-5.3")).not.toBe(routed("unknown-vendor/model"));
});
