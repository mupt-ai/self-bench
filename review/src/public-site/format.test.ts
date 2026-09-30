import { expect, test } from "bun:test";
import { accuracyTick, compactNumber, settingLabel, vendorColor, vendorName } from "./format";
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
  const onEndpoint = (number: number, accuracy: number) =>
    setting({
      id: `my-llama|pi|custom|api-key|default|#${number}`,
      model: { catalogId: "custom", name: "my-llama", label: "my-llama" },
      harness: "pi",
      provider: "custom",
      custom: true,
      reasoningLevel: "default",
      accuracy,
    });
  const first = onEndpoint(1, 60);
  const second = onEndpoint(2, 55);
  const all = [first, second];
  expect(settingLabel(first, all)).toBe("my-llama (Endpoint 1)");
  expect(settingLabel(second, all)).toBe("my-llama (Endpoint 2)");
  expect(settingLabel(first, [first])).toBe("my-llama");
  // The id's number wins over listing order, so the label always names the id's setting.
  expect(settingLabel(first, [second, first])).toBe("my-llama (Endpoint 1)");
});

test("an older release's fingerprinted twins are numbered in listing order", () => {
  const old = (fingerprint: string) =>
    setting({
      id: `my-llama|pi|custom|api-key|default|#${fingerprint}`,
      model: { catalogId: "custom", name: "my-llama", label: "my-llama" },
      harness: "pi",
      provider: "custom",
      custom: true,
      reasoningLevel: "default",
    });
  const [a, b] = [old("12345678"), old("9abcdef0")];
  expect([a, b].map((entry) => settingLabel(entry, [a, b]))).toEqual([
    "my-llama (Endpoint 1)",
    "my-llama (Endpoint 2)",
  ]);
});

test("accuracy ticks above 100% are left unlabelled", () => {
  expect(accuracyTick(100)).toBe("100%");
  expect(accuracyTick(92.5)).toBe("92.5%");
  expect(accuracyTick(102.5)).toBe("");
});

test("counts shorten to thousands, and past a million to millions", () => {
  expect(compactNumber(950)).toBe("950");
  expect(compactNumber(9_500)).toBe("9.5k");
  expect(compactNumber(137_842)).toBe("138k");
  expect(compactNumber(1_250_000)).toBe("1.3M");
});
