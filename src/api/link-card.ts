import { resolve } from "node:path";
import { Resvg } from "@resvg/resvg-js";
import { harnessLabels } from "../evaluation/models.js";
import type { PublishedRelease, ReleaseSetting } from "../public/release-types.js";
import { vendorColor } from "../public/vendors.js";

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
const PAD = 64;

/** The site's dark palette (review/src/public-site/palette.css), which reads well in any feed. */
const INK = {
  background: "#090c10",
  card: "#10151b",
  foreground: "#d5dce3",
  muted: "#8b949e",
  faint: "#5e6670",
  border: "#222933",
} as const;

/** JetBrains Mono, the site's face, bundled with its license in assets/fonts. */
const FONTS = ["Regular", "Medium", "Bold"].map((weight) =>
  resolve(process.cwd(), `assets/fonts/JetBrainsMono-${weight}.ttf`),
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
const percent = (value: number) => `${value.toFixed(value % 1 === 0 ? 0 : 1)}%`;
const dollars = (value: number) => (value === 0 ? "$0" : `$${value.toFixed(value < 0.1 ? 3 : 2)}`);
const compact = (value: number) =>
  value >= 1_000_000
    ? `${(value / 1_000_000).toFixed(1)}M`
    : value >= 1000
      ? `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}k`
      : String(value);
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** A setting as a preview names it: its model, and its harness when the model runs in several. */
function nameOf(setting: ReleaseSetting, all: readonly ReleaseSetting[]) {
  const twins = all.filter((other) => other.model.label === setting.model.label);
  const harnesses = new Set(twins.map((other) => other.harness));
  if (harnesses.size === 1) return setting.model.label;
  return `${setting.model.label} (${harnessLabels[setting.harness] ?? setting.harness})`;
}

/** The frontier's settings from most accurate down: what the card lists beside its chart. */
function frontier(settings: readonly ReleaseSetting[]) {
  return settings
    .filter((setting) => setting.onFrontier)
    .sort((left, right) => right.accuracy - left.accuracy);
}

/**
 * The chart's cost axis, as log10 of its ends: the settings' costs, padded a little on each side.
 * $0 costs sit at the axis start. A release with only $0 costs, as sign-in runs record, gets a
 * short range around $1, so the axis still runs from low to high.
 */
export function costRange(
  settings: readonly Pick<ReleaseSetting, "costPerTaskUsd">[],
): [number, number] {
  const costs = settings.map((setting) => setting.costPerTaskUsd).filter((cost) => cost > 0);
  if (costs.length === 0) return [Math.log10(1 / 1.3), Math.log10(1.3)];
  return [Math.log10(Math.min(...costs) / 1.3), Math.log10(Math.max(...costs) * 1.3)];
}

/** Accuracy against cost on a log axis, frontier filled and joined, the rest as rings. */
function chart(
  settings: readonly ReleaseSetting[],
  box: { x: number; y: number; w: number; h: number },
) {
  const [low, high] = costRange(settings);
  const floor = Math.max(
    0,
    Math.floor((Math.min(100, ...settings.map((s) => s.accuracy)) - 5) / 10) * 10,
  );
  const x = (cost: number) =>
    box.x + (cost > 0 ? ((Math.log10(cost) - low) / (high - low)) * box.w : 0);
  const y = (accuracy: number) => box.y + box.h - ((accuracy - floor) / (100 - floor)) * box.h;
  const grid = [floor, floor + (100 - floor) / 2, 100]
    .map(
      (value) =>
        `<line x1="${box.x}" x2="${box.x + box.w}" y1="${y(value)}" y2="${y(value)}" stroke="${INK.border}" stroke-width="2"/>` +
        `<text x="${box.x - 14}" y="${y(value) + 7}" font-size="20" fill="${INK.faint}" text-anchor="end">${value}%</text>`,
    )
    .join("");
  const line = [...frontier(settings)]
    .sort((left, right) => left.costPerTaskUsd - right.costPerTaskUsd)
    .map((setting) => `${x(setting.costPerTaskUsd).toFixed(1)},${y(setting.accuracy).toFixed(1)}`)
    .join(" ");
  // Rings first, so the frontier's filled points sit on top.
  const points = [...settings]
    .sort((left, right) => Number(left.onFrontier) - Number(right.onFrontier))
    .map((setting) => {
      const at = `cx="${x(setting.costPerTaskUsd).toFixed(1)}" cy="${y(setting.accuracy).toFixed(1)}"`;
      const color = vendorColor(setting);
      return setting.onFrontier
        ? `<circle ${at} r="9" fill="${color}" stroke="${INK.card}" stroke-width="3"/>`
        : `<circle ${at} r="6.5" fill="${INK.card}" stroke="${color}" stroke-width="3"/>`;
    })
    .join("");
  const ticks = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100]
    .filter((tick) => Math.log10(tick) >= low && Math.log10(tick) <= high)
    .map(
      (tick) =>
        `<line x1="${x(tick)}" x2="${x(tick)}" y1="${box.y + box.h}" y2="${box.y + box.h + 8}" stroke="${INK.faint}" stroke-width="2"/>` +
        `<text x="${x(tick)}" y="${box.y + box.h + 34}" font-size="18" fill="${INK.faint}" text-anchor="middle">${dollars(tick)}</text>`,
    )
    .join("");
  return `${grid}${ticks}<polyline points="${line}" fill="none" stroke="${INK.muted}" stroke-width="2.5" stroke-dasharray="8 9" opacity="0.8"/>${points}
    <text x="${box.x + box.w}" y="${box.y + box.h + 72}" font-size="18" fill="${INK.faint}" text-anchor="end" letter-spacing="1.5">COST PER TASK →</text>`;
}

/** The preview image of one release, as SVG: the repository, its frontier, and the chart. */
function cardSvg(release: PublishedRelease): string {
  const { repository, publisher } = release;
  // The name shrinks to fit one line, from 64px down to 36px. Past that the owner is shortened
  // from the left, keeping the repository's own name whole, and only then the end is cut.
  const nameSize = Math.max(
    36,
    Math.min(64, (WIDTH - PAD * 2) / (repository.fullName.length * ADVANCE)),
  );
  const room = Math.floor((WIDTH - PAD * 2) / (nameSize * ADVANCE));
  const [owner = "", repo = ""] = repository.fullName.split("/");
  const name =
    repository.fullName.length <= room
      ? repository.fullName
      : repo.length + 3 <= room
        ? `…${owner.slice(owner.length - (room - repo.length - 2))}/${repo}`
        : clip(repo, room);
  const hasStars = repository.stars !== undefined;
  // Single spaces, as SVG draws runs of spaces as one; the stars' separator ends the text, so
  // the star follows it one space on.
  const facts = `${[
    plural(release.tasks, "task"),
    plural(release.settings.length, "setting"),
    `run by ${publisher.login}`,
  ].join(" · ")}${hasStars ? " ·" : ""}`;
  const nameLine = 118 + nameSize * 0.82;
  const factsLine = nameLine + 42;
  // The stars after the facts, as the site's cards show them: a star, then the count.
  const starX = PAD + (facts.length + 1) * 22 * ADVANCE;
  const stars =
    repository.stars === undefined
      ? ""
      : `<path d="${STAR}" transform="translate(${starX.toFixed(1)} ${(factsLine - 18).toFixed(1)}) scale(0.83)" fill="${INK.muted}"/>
  <text x="${(starX + 24).toFixed(1)}" y="${factsLine.toFixed(1)}" font-size="22" fill="${INK.muted}">${compact(repository.stars)}</text>`;
  const listed = frontier(release.settings).slice(0, 5);
  const rows = listed
    .map((setting, index) => {
      const top = 312 + index * 50;
      return `<rect x="${PAD}" y="${top - 17}" width="18" height="18" fill="${vendorColor(setting)}"/>
        <text x="${PAD + 30}" y="${top}" font-size="26" fill="${INK.foreground}">${escapeXml(clip(nameOf(setting, release.settings), 17))}</text>
        <text x="${PAD + 430}" y="${top}" font-size="26" fill="${INK.foreground}" text-anchor="end" font-weight="700">${percent(setting.accuracy)}</text>
        <text x="${PAD + 450}" y="${top}" font-size="22" fill="${INK.muted}">${dollars(setting.costPerTaskUsd)}</text>`;
    })
    .join("");
  // The dari mark, 52px wide, beside "self-bench" over "by dari.dev", as the site's header has it.
  const markScale = 0.08;
  const mark = `<g transform="translate(${(PAD - 178 * markScale).toFixed(1)} ${(60 - 340 * markScale).toFixed(1)}) scale(${markScale})" fill="${INK.foreground}">${DARI_MARK.map((d) => `<path d="${d}"/>`).join("")}</g>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" font-family="JetBrains Mono">
  <rect width="${WIDTH}" height="${HEIGHT}" fill="${INK.background}"/>
  <rect x="24" y="24" width="${WIDTH - 48}" height="${HEIGHT - 48}" fill="${INK.card}" stroke="${INK.border}" stroke-width="2"/>
  ${mark}
  <text x="${PAD + 66}" y="72" font-size="24" fill="${INK.foreground}" font-weight="700">self-bench</text>
  <text x="${PAD + 66}" y="96" font-size="17" fill="${INK.muted}">by dari.dev</text>
  <text x="${WIDTH - PAD}" y="84" font-size="20" fill="${INK.muted}" text-anchor="end">selfbench.dev</text>
  <text x="${PAD}" y="${nameLine.toFixed(1)}" font-size="${nameSize.toFixed(1)}" fill="${INK.foreground}" font-weight="700">${escapeXml(name)}</text>
  <text x="${PAD}" y="${factsLine.toFixed(1)}" font-size="22" fill="${INK.muted}">${escapeXml(facts)}</text>
  ${stars}
  <text x="${PAD}" y="272" font-size="16" fill="${INK.faint}" letter-spacing="1.5">PARETO FRONTIER</text>
  <text x="${PAD + 430}" y="272" font-size="16" fill="${INK.faint}" letter-spacing="1.5" text-anchor="end">ACCURACY</text>
  <text x="${PAD + 450}" y="272" font-size="16" fill="${INK.faint}" letter-spacing="1.5">$/TASK</text>
  ${rows}
  ${chart(release.settings, { x: 680, y: 262, w: 456, h: 250 })}
</svg>`;
}

/** The preview image as a PNG, which every unfurler accepts (SVG is not). */
export function cardPng(release: PublishedRelease): Buffer {
  const png = new Resvg(cardSvg(release), {
    font: { fontFiles: FONTS, loadSystemFonts: false, defaultFontFamily: "JetBrains Mono" },
    fitTo: { mode: "width", value: WIDTH },
  })
    .render()
    .asPng();
  return Buffer.from(png);
}
