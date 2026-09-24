/**
 * The input device, as scripts ask about it, with the same media queries as the styles: the
 * `touch:` variant in mobile.css and Tailwind's `hover:`, so styles and behaviour agree.
 */

/** A finger rather than a mouse. */
const TOUCH = "(pointer: coarse)";
/** A pointer that can hover, as Tailwind's `hover:` and the card's hover state count it. */
const HOVER = "(hover: hover)";

const matches = (query: string) =>
  typeof window !== "undefined" && window.matchMedia(query).matches;

/**
 * Whether the visitor taps rather than points. Phones and tablets bring their own gestures,
 * such as swiping back, which page transitions should not repeat.
 */
export const touchInput = () => matches(TOUCH);

/** Whether the pointer can hover, so hover states mean anything. */
export const canHover = () => matches(HOVER);
