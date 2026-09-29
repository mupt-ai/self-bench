import { expect, test } from "bun:test";
import { accuracyTick, settingLabel, vendorColor, vendorName } from "./format";
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

test("vendors are named as they write it, and unknown vendors keep their id", () => {
  const routed = (name: string) =>
    vendorName(
      setting({ id: name, provider: "openrouter", model: { catalogId: "x", name, label: "X" } }),
    );
  expect(routed("openrouter/z-ai/glm-5.3")).toBe("Z.ai");
  expect(routed("moonshotai/kimi")).toBe("Moonshot AI");
  expect(routed("mistralai/codestral")).toBe("mistralai");
  expect(vendorName(setting({ id: "direct", provider: "anthropic" }))).toBe("Anthropic");
});

test("custom models that differ only by endpoint are numbered, not told apart by host", () => {
  const onEndpoint = (hash: string, accuracy: number) =>
    setting({
      id: `my-llama|pi|custom|api-key|default|#${hash}`,
      model: { catalogId: "custom", name: "my-llama", label: "my-llama" },
      harness: "pi",
      provider: "custom",
      custom: true,
      reasoningLevel: "default",
      accuracy,
    });
  const first = onEndpoint("1a2b3c4d", 60);
  const second = onEndpoint("5e6f7a8b", 55);
  const all = [first, second];
  expect(settingLabel(first, all)).toBe("my-llama (Endpoint 1)");
  expect(settingLabel(second, all)).toBe("my-llama (Endpoint 2)");
  expect(settingLabel(first, [first])).toBe("my-llama");
});

test("accuracy ticks above 100% are left unlabelled", () => {
  expect(accuracyTick(100)).toBe("100%");
  expect(accuracyTick(92.5)).toBe("92.5%");
  expect(accuracyTick(102.5)).toBe("");
});
