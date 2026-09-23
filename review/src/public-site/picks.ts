import type { PublicPick, PublicSetting } from "./contract";

/** Frontier settings, cheapest first; accuracy breaks cost ties, then id. */
export function frontierSettings(settings: readonly PublicSetting[]): PublicSetting[] {
  return settings
    .filter((setting) => setting.onFrontier)
    .sort(
      (left, right) =>
        left.costPerTaskUsd - right.costPerTaskUsd ||
        right.accuracy - left.accuracy ||
        left.id.localeCompare(right.id),
    );
}

/**
 * The two picks a card names: the cheapest frontier setting and the most accurate one. When
 * one setting is both, it appears once with both roles. The rest of the frontier lives on
 * the repository page's chart.
 */
export function picks(settings: readonly PublicSetting[]): PublicPick[] {
  const frontier = frontierSettings(settings);
  const cheapest = frontier[0];
  const mostAccurate = [...frontier].sort(
    (left, right) =>
      right.accuracy - left.accuracy ||
      left.costPerTaskUsd - right.costPerTaskUsd ||
      left.id.localeCompare(right.id),
  )[0];
  if (!cheapest || !mostAccurate) return [];
  if (cheapest.id === mostAccurate.id)
    return [{ setting: cheapest, roles: ["cheapest", "mostAccurate"] }];
  return [
    { setting: cheapest, roles: ["cheapest"] },
    { setting: mostAccurate, roles: ["mostAccurate"] },
  ];
}
