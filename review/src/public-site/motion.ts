/** True when animation should be skipped: the visitor's system asks for less motion. */
export function motionOff(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
