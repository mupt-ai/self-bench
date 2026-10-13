import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { controlStyles, Select } from "./ui";

test("selects truncate long selected labels without changing the option text", () => {
  const name = "avyay-claude-code-with-a-really-long-credential-name";
  const markup = renderToStaticMarkup(
    <Select aria-label="Credential" value="claude" onChange={() => {}}>
      <option value="claude">{name}</option>
    </Select>,
  );
  expect(markup).toMatch(/<select[^>]*class="[^"]*\btruncate\b/);
  expect(markup).toContain(name);
});

test("form controls use text-base on mobile so iOS does not zoom on focus", () => {
  const classes = controlStyles.split(" ");
  expect(classes).toContain("text-base");
  expect(classes).toContain("md:text-sm");
  expect(classes).not.toContain("text-sm");
});
