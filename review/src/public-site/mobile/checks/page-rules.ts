/**
 * The rules every page must meet on a phone, measured in the page itself. The functions here
 * run in the browser (`page.evaluate`), so each must stay self-contained: no imports, and no
 * helpers from outside its own body.
 */

export type Rule = "overflow" | "tap" | "text" | "field" | "hover";

export interface Problem {
  rule: Rule;
  /** The element, as a person would find it: its tag, first classes, and label or text. */
  element: string;
  detail: string;
}

/** How each broken rule is fixed, shown above the elements that break it. */
export const FIXES: Record<Rule, string> = {
  overflow:
    "Wider than the screen, so the page scrolls sideways. Let it shrink or wrap (min-w-0, flex-wrap, break-words, <wbr />), or give it a `compact:` size. Do not hide the overflow to pass.",
  tap: "A control smaller than a fingertip (44px). Add `hit relative` to it (mobile/mobile.css), or `touch:` padding where there is room.",
  text: "Text under 11px, too small to read on a phone. Use `compact:text-[11px]` or larger.",
  field:
    "A field under 16px on a touch screen: iOS zooms the page into it on focus. mobile.css sets 16px; do not set a smaller size for touch.",
  hover:
    "A :hover style outside @media (hover: hover). A tap leaves :hover stuck on, so it stays applied after a tap. Use Tailwind's `hover:` variant, which is gated, or wrap the rule in that query.",
};

export function pageProblems(): Problem[] {
  const TAP = 44;
  const TEXT = 11;
  const FIELD = 16;
  // The screen's width as the page is laid out for it. (A phone zooms out to show a page that
  // is too wide, which widens innerWidth along with it.)
  const width = document.documentElement.clientWidth;
  const problems: Problem[] = [];

  const describe = (element: Element) => {
    const name = (element.getAttribute("aria-label") ?? element.textContent ?? "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 40);
    const classes = [...element.classList].slice(0, 4).join(".");
    return `<${element.tagName.toLowerCase()}${classes ? `.${classes}` : ""}>${name ? ` "${name}"` : ""}`;
  };
  // A deliberate exception, marked in the markup with a comment on why: data-phone-ok="tap".
  const excused = (element: Element, rule: Rule) =>
    element.closest(`[data-phone-ok~="${rule}"]`) !== null;
  // Decoration and transition snapshots are not the page.
  const shown = (element: Element) =>
    element.closest('[aria-hidden="true"], [inert]') === null &&
    element.checkVisibility({ opacityProperty: true, visibilityProperty: true });
  const all = [...document.body.querySelectorAll("*")].filter(shown);

  // Sideways overflow, reported where it starts: the outermost element past the edge, not
  // everything inside it. Anything in a box that scrolls or clips sideways is that box's own.
  const clipped = (element: Element) => {
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      if (getComputedStyle(parent).overflowX !== "visible") return true;
    }
    return false;
  };
  const past = (element: Element | null) => {
    if (!element || element === document.body) return false;
    const box = element.getBoundingClientRect();
    return box.width > 0 && (box.right > width + 1 || box.left < -1);
  };
  const widest = Math.max(document.documentElement.scrollWidth, window.innerWidth);
  if (widest > width + 1) {
    problems.push({
      rule: "overflow",
      element: "<html>",
      detail: `the page is ${widest}px wide on a ${width}px screen`,
    });
  }
  for (const element of all) {
    if (!past(element) || past(element.parentElement) || clipped(element)) continue;
    // Pinned elements follow the window, and only widen with it when something else is wide.
    if (excused(element, "overflow") || getComputedStyle(element).position === "fixed") continue;
    const box = element.getBoundingClientRect();
    problems.push({
      rule: "overflow",
      element: describe(element),
      detail: `spans ${Math.round(box.left)} to ${Math.round(box.right)}px on a ${width}px screen`,
    });
  }

  // Tap targets. A control's area is its box, grown by the invisible area `hit` adds on touch,
  // or its label's box (a tap on a label is a tap on its field). A link inside a sentence is
  // exempt: the text around it sets its size.
  const CONTROLS =
    'a[href], button, input, select, textarea, summary, [role="button"], [role="link"], [role="tab"], [role="menuitem"]';
  for (const element of all) {
    if (!element.matches(CONTROLS) || excused(element, "tap")) continue;
    const box = element.getBoundingClientRect();
    // Visually hidden (sr-only) controls have no size to tap.
    if (box.width <= 1 || box.height <= 1) continue;
    const ownText = element.textContent?.trim().length ?? 0;
    const around = element.parentElement?.textContent?.trim().length ?? 0;
    if (getComputedStyle(element).display === "inline" && around > ownText) continue;
    let tapWidth = box.width;
    let tapHeight = box.height;
    const after = getComputedStyle(element, "::after");
    if (after.content !== "none" && after.position === "absolute") {
      const inset = (side: string) => Number.parseFloat(after.getPropertyValue(side)) || 0;
      tapWidth = Math.max(tapWidth, box.width - inset("left") - inset("right"));
      tapHeight = Math.max(tapHeight, box.height - inset("top") - inset("bottom"));
    }
    const label = element.closest("label")?.getBoundingClientRect();
    if (label) {
      tapWidth = Math.max(tapWidth, label.width);
      tapHeight = Math.max(tapHeight, label.height);
    }
    if (tapWidth + 0.5 < TAP || tapHeight + 0.5 < TAP) {
      problems.push({
        rule: "tap",
        element: describe(element),
        detail: `${Math.round(tapWidth)}x${Math.round(tapHeight)}px`,
      });
    }
  }

  // Text size, for every element with text of its own.
  const small = new Map<string, Problem>();
  for (const element of all) {
    if (excused(element, "text")) continue;
    const hasText = [...element.childNodes].some(
      (node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim(),
    );
    const size = Number.parseFloat(getComputedStyle(element).fontSize);
    if (hasText && size < TEXT) {
      const problem: Problem = { rule: "text", element: describe(element), detail: `${size}px` };
      small.set(`${problem.element} ${problem.detail}`, problem);
    }
  }
  problems.push(...small.values());

  // Fields on a touch screen, which iOS zooms into when they are under 16px.
  if (matchMedia("(pointer: coarse)").matches) {
    for (const element of all) {
      if (!element.matches("input, select, textarea") || excused(element, "field")) continue;
      const size = Number.parseFloat(getComputedStyle(element).fontSize);
      if (size < FIELD) {
        problems.push({ rule: "field", element: describe(element), detail: `${size}px` });
      }
    }
  }

  // :hover styles that could stick on after a tap: those outside @media (hover: hover) that
  // match something on this page. (The stylesheet also holds the app's classes, which Tailwind
  // finds beside the site; those never reach these pages.)
  const onPage = (selector: string) => {
    try {
      return document.querySelector(selector.replace(/(?<!\\):hover/g, "")) !== null;
    } catch {
      return false;
    }
  };
  const walk = (rules: CSSRuleList, gated: boolean) => {
    for (const rule of rules) {
      if (rule instanceof CSSMediaRule) {
        walk(rule.cssRules, gated || /\(\s*hover\s*:\s*hover\s*\)/.test(rule.conditionText));
      } else if (rule instanceof CSSStyleRule) {
        const { selectorText } = rule;
        if (!gated && /(?<!\\):hover/.test(selectorText) && onPage(selectorText)) {
          problems.push({ rule: "hover", element: selectorText, detail: "not gated" });
        }
        walk(rule.cssRules, gated);
      } else if ("cssRules" in rule) {
        walk((rule as CSSGroupingRule).cssRules, gated);
      }
    }
  };
  for (const sheet of document.styleSheets) {
    try {
      walk(sheet.cssRules, false);
    } catch {
      // Another origin's sheet (the web fonts) cannot be read, and is not the site's.
    }
  }
  return problems;
}

/**
 * The share of the screen's height covered by bars pinned to its top or bottom, which leaves
 * the rest for the page.
 */
export function pinnedShare(): number {
  let covered = 0;
  for (const element of document.body.querySelectorAll("*")) {
    const { position } = getComputedStyle(element);
    if (position !== "fixed" && position !== "sticky") continue;
    if (element.closest('[aria-hidden="true"], [inert]') || !element.checkVisibility()) continue;
    const box = element.getBoundingClientRect();
    const bar = box.width >= window.innerWidth * 0.9 && box.height < window.innerHeight / 2;
    const atEdge = box.top <= 0.5 || box.bottom >= window.innerHeight - 0.5;
    if (bar && atEdge) {
      covered += Math.max(0, Math.min(box.bottom, innerHeight) - Math.max(box.top, 0));
    }
  }
  return covered / window.innerHeight;
}
