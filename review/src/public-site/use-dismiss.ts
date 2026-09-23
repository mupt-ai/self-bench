import { type RefObject, useEffect } from "react";

/** While `open`, closes on Escape or on a pointer press outside `container`. */
export function useDismiss(
  open: boolean,
  container: RefObject<HTMLElement | null>,
  close: () => void,
): void {
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: Event) => {
      if (
        event instanceof KeyboardEvent
          ? event.key === "Escape"
          : !container.current?.contains(event.target as Node)
      )
        close();
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", dismiss);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", dismiss);
    };
  }, [open, container, close]);
}
