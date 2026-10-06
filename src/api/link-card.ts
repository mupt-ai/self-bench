import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";
import type { PublishedGroupRelease, PublishedRelease } from "../public/release-types.js";

/**
 * The picture a shared repository page shows in Slack, X, LinkedIn, Discord and iMessage: the
 * image of its link preview, 1200 × 630, drawn by the server for each release. The page's head
 * (site-head.ts) points `og:image` at it; unfurlers never run the page's scripts.
 */

export const CARD_WIDTH = 1200;
export const CARD_HEIGHT = 630;
const WIDTH = CARD_WIDTH;
const HEIGHT = CARD_HEIGHT;

/** Where a repository's preview image is served: its default line's, or one publisher's. */
export function cardPath(fullName: string, publisher?: string): string {
  return `/og/${fullName}${publisher ? `/${publisher}` : ""}.png`;
}

/** Where a group's preview image is served. */
export const groupCardPath = (slug: string) => `/og/groups/${slug}.png`;

/** What a card names and counts: a repository with its stars, or a group with its repositories. */
interface CardFace {
  name: string;
  tasks: number;
  settings: number;
  stars?: number;
  repositories?: number;
}

const repositoryFace = (release: PublishedRelease): CardFace => ({
  name: release.repository.fullName,
  tasks: release.tasks,
  settings: release.settings.length,
  ...(release.repository.stars === undefined ? {} : { stars: release.repository.stars }),
});

const groupFace = (release: PublishedGroupRelease): CardFace => ({
  name: release.group.name,
  tasks: release.tasks,
  settings: release.settings.length,
  repositories: release.group.members.length,
});
const PAD = 72;

/** The site's dark palette (review/src/public-site/palette.css), which reads well in any feed. */
const INK = {
  card: "#10151b",
  foreground: "#d5dce3",
  // A step lighter than the site's muted grey, to read at a third of the size.
  muted: "#a1aab4",
} as const;

/** JetBrains Mono, the site's face, bundled with its license in assets/fonts. */
const FONTS = ["Regular", "Medium", "Bold"].map((weight) =>
  // Beside this module (src/api, or dist/api once built), so any working directory finds them.
  fileURLToPath(new URL(`../../assets/fonts/JetBrainsMono-${weight}.ttf`, import.meta.url)),
);
/** The dari mark's paths (review/src/web/Lockup.tsx), in a 1024 box; the mark spans x 178–836, y 340–643. */
const DARI_MARK = [
  "M227.174 643.267C309.13 501.04 353.3 382.247 461.711 379.747c100.278 6.927 172.975 162.686 217.376 263.52h110.942c-81.304-117.797-196.325-301.555-326.906-303.36-166.044-4.954-236.495 312.426-235.949 303.36",
  "M657.933 552.765h177.78V487.33l-224.079 18.712 44.162 15.727zM327.444 446.849h14.02v89.346h-14.02z",
  "M368.884 403.285h13.92v129.377h-13.92z",
  "M413.178 382.234h13.886v144.712h-13.886zm48.935-4.033h13.886v144.712h-13.886z",
  "M525.783 410.11h.44v-.31h-.44zm-13.447.421v118.442h13.887V423.498a300 300 0 0 0-13.887-12.967",
  "m593.563 507.768-329.946 33.841-85.683 11.157h444.87c-9.563-15.205-19.29-30.327-29.241-44.998",
];

/** Lucide's star (review's cards use it through lucide-react), in a 24 box. */
const STAR =
  "M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z";

/** Advance of one JetBrains Mono character, in ems. */
const ADVANCE = 0.6;

const escapeXml = (text: string) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
const clip = (text: string, length: number) =>
  text.length <= length ? text : `${text.slice(0, length - 1)}…`;
const compact = (value: number) =>
  value >= 1_000_000
    ? `${(value / 1_000_000).toFixed(1)}M`
    : value >= 1000
      ? `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}k`
      : String(value);
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** Where the header's ink ends: the lockup and the address above it. */
const HEADER = 166;

/** The width text may take: the card less its margins. */
const LINE = WIDTH - PAD * 2;
const chars = (size: number) => Math.floor(LINE / (size * ADVANCE) + 1e-9);

/** Splits `text` into lines of at most `perLine` characters, breaking after - _ or . when it can. */
function wrap(text: string, perLine: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const piece of text.match(/[^-_.]+[-_.]?|[-_.]/g) ?? []) {
    if (line.length + piece.length <= perLine) {
      line += piece;
      continue;
    }
    if (line) lines.push(line);
    line = piece;
    while (line.length > perLine) {
      lines.push(line.slice(0, perLine));
      line = line.slice(perLine);
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** `wrap`, with its lines as even as they go: the narrowest width that needs no more of them. */
function balanced(text: string, perLine: number): string[] {
  const lines = wrap(text, perLine);
  for (let width = Math.ceil(text.length / lines.length); width < perLine; width++) {
    const even = wrap(text, width);
    if (even.length === lines.length) return even;
  }
  return lines;
}

/**
 * The repository's name as the card sets it, as large as it goes up to 112px: on one line while
 * that stays at least 80px, else the owner over the repository. A name longer still keeps the
 * owner to one line and wraps the repository over two, from 72px down to 48px; at 48px the
 * owner is shortened from the left and the repository cut short.
 */
export function nameLayout(fullName: string): { size: number; lines: string[] } {
  const slash = fullName.indexOf("/");
  const owner = fullName.slice(0, slash + 1);
  const repo = fullName.slice(slash + 1);
  const fit = (lineLength: number) => Math.min(112, LINE / (lineLength * ADVANCE));
  const one = fit(fullName.length);
  const two = fit(Math.max(owner.length, repo.length));
  if (one >= 80 || one >= two) return { size: one, lines: [fullName] };
  if (two >= 72) return { size: two, lines: [owner, repo] };
  for (let size = 72; size >= 48; size -= 2) {
    const repoLines = balanced(repo, chars(size));
    if (owner.length <= chars(size) && repoLines.length <= 2)
      return { size, lines: [owner, ...repoLines] };
  }
  const room = chars(48);
  const [first = "", ...rest] = balanced(repo, room);
  return {
    size: 48,
    lines: [
      owner.length <= room ? owner : `…${owner.slice(owner.length - room + 1)}`,
      first,
      ...(rest.length > 0 ? [clip(rest.join(""), room)] : []),
    ],
  };
}

/**
 * The preview image of one release, as SVG. Unfurlers show it at a third to a half of its size,
 * and keep it as it was when the link was shared, so it says only what holds for a while, and
 * large: the site above, then the repository and how much was measured, centred in the space
 * below. No results: they change as settings are added, and the page's own preview text names
 * them.
 */
function cardSvg(face: CardFace): string {
  const { size, lines } = nameLayout(face.name);
  const leading = size * 1.1;
  // The name and the facts under it, centred as they look (from the name's capitals to the facts'
  // descenders) between the header and the card's foot.
  const inked = size * 0.07 + lines.length * leading + 66;
  const top = (HEADER + HEIGHT) / 2 - inked / 2;
  const name = lines
    .map(
      (line, index) =>
        `<text x="${PAD}" y="${(top + size * 0.8 + index * leading).toFixed(1)}" font-size="${size.toFixed(1)}" fill="${INK.foreground}" font-weight="700">${escapeXml(line)}</text>`,
    )
    .join("");
  const factsLine = top + lines.length * leading + 56;
  // Single spaces, as SVG draws runs of spaces as one; the stars' separator ends the text, so the
  // star follows it one space on, as the site's cards show them: a star, then the count. Stars
  // are short ("143k"), so the line fits at 44px; it shrinks should a count ever run long.
  const count = face.stars === undefined ? "" : compact(face.stars);
  const facts = `${[
    ...(face.repositories === undefined ? [] : [plural(face.repositories, "repo")]),
    plural(face.tasks, "task"),
    plural(face.settings, "setting"),
  ].join(" · ")}${count ? " ·" : ""}`;
  const ems = (facts.length + (count ? 1 + count.length : 0)) * ADVANCE + (count ? 1 : 0);
  const factsSize = Math.min(44, LINE / ems);
  const starX = PAD + (facts.length + 1) * factsSize * ADVANCE;
  const stars = count
    ? `<path d="${STAR}" transform="translate(${starX.toFixed(1)} ${(factsLine - factsSize * 0.78).toFixed(1)}) scale(${(factsSize / 29).toFixed(3)})" fill="${INK.muted}"/>
  <text x="${(starX + factsSize).toFixed(1)}" y="${factsLine.toFixed(1)}" font-size="${factsSize.toFixed(1)}" fill="${INK.muted}" font-weight="500">${count}</text>`
    : "";
  // The dari mark, 128px wide, beside "self-bench" over "by dari.dev", as the site's header has it.
  const markScale = 128 / 658;
  const mark = `<g transform="translate(${(PAD - 178 * markScale).toFixed(1)} ${(88 - 340 * markScale).toFixed(1)}) scale(${markScale.toFixed(4)})" fill="${INK.foreground}">${DARI_MARK.map((d) => `<path d="${d}"/>`).join("")}</g>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" font-family="JetBrains Mono">
  <rect width="${WIDTH}" height="${HEIGHT}" fill="${INK.card}"/>
  ${mark}
  <text x="${PAD + 156}" y="112" font-size="60" fill="${INK.foreground}" font-weight="700">self-bench</text>
  <text x="${PAD + 156}" y="158" font-size="36" fill="${INK.muted}" font-weight="500">by dari.dev</text>
  <text x="${WIDTH - PAD}" y="112" font-size="48" fill="${INK.foreground}" font-weight="500" text-anchor="end">selfbench.dev</text>
  ${name}
  <text x="${PAD}" y="${factsLine.toFixed(1)}" font-size="${factsSize.toFixed(1)}" fill="${INK.muted}" font-weight="500">${escapeXml(facts)}</text>
  ${stars}
</svg>`;
}

/** The preview image as a PNG, which every unfurler accepts (SVG is not). */
export function cardPng(release: PublishedRelease | PublishedGroupRelease): Buffer {
  // resvg draws a missing font as no text at all, so a card without its fonts fails instead.
  const missing = FONTS.find((file) => !existsSync(file));
  if (missing) throw new Error(`The link preview's font is missing: ${missing}`);
  const face = "group" in release ? groupFace(release) : repositoryFace(release);
  const png = new Resvg(cardSvg(face), {
    font: { fontFiles: FONTS, loadSystemFonts: false, defaultFontFamily: "JetBrains Mono" },
    fitTo: { mode: "width", value: WIDTH },
  })
    .render()
    .asPng();
  return Buffer.from(png);
}
