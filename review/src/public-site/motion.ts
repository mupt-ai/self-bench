/** The visitor's "Disable Animations" choice, kept like the theme: on the root, remembered. */
const MOTION_KEY = "selfbench-motion";

export function readMotionOff(storage: Pick<Storage, "getItem"> | undefined): boolean {
  try {
    return storage?.getItem(MOTION_KEY) === "off";
  } catch {
    return false;
  }
}

export function applyMotionOff(root: HTMLElement, off: boolean): void {
  if (off) root.setAttribute("data-motion", "off");
  else root.removeAttribute("data-motion");
}

export function rememberMotionOff(storage: Pick<Storage, "setItem"> | undefined, off: boolean) {
  try {
    storage?.setItem(MOTION_KEY, off ? "off" : "on");
  } catch {
    // Private windows and blocked storage: the choice lasts until the next load.
  }
}

/** True when animation should be skipped: the visitor's choice or their system setting. */
export function motionOff(): boolean {
  return (
    document.documentElement.dataset.motion === "off" ||
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}
