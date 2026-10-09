import { type MouseEvent, type ReactNode, type RefObject, useEffect, useRef } from "react";

/**
 * Whether a pointer event on a modal `<dialog>` landed on the page around it. The page is the
 * dialog's backdrop, whose clicks land on the dialog itself; one inside the dialog lands on what
 * it is over, or on the dialog within its box.
 */
function onBackdrop(event: MouseEvent<HTMLDialogElement>): boolean {
  const box = event.currentTarget.getBoundingClientRect();
  return (
    event.target === event.currentTarget &&
    (event.clientX < box.left ||
      event.clientX > box.right ||
      event.clientY < box.top ||
      event.clientY > box.bottom)
  );
}

/**
 * The frame the site's viewers (a task, a trace) open in over the page: a modal `<dialog>`, so the
 * browser traps focus and it sits above the pinned bars, filling the screen on a phone. Focus
 * starts on `initialFocus`. Escape closes it through `onClose` (the address), as does a click on
 * the page around it that also began there: letting go out there after selecting text inside
 * leaves it open.
 */
export function ViewerDialog({
  labelledBy,
  initialFocus,
  onClose,
  className = "",
  children,
}: {
  labelledBy: string;
  initialFocus: RefObject<HTMLElement | null>;
  onClose(): void;
  /** Its width, and anything else particular to the viewer. */
  className?: string;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  // Whether the press now under way began on the page around the viewer.
  const pressedOutside = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: opened once, focused once
  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
    initialFocus.current?.focus();
    return () => element?.close();
  }, []);
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: Escape is the keyboard's way to close it (onCancel)
    <dialog
      ref={dialog}
      aria-labelledby={labelledBy}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onPointerDown={(event) => {
        pressedOutside.current = onBackdrop(event);
      }}
      onClick={(event) => {
        if (pressedOutside.current && onBackdrop(event)) onClose();
        pressedOutside.current = false;
      }}
      className={`m-auto flex h-[min(100dvh-4rem,60rem)] max-h-none max-w-none flex-col border-[1.5px] border-(--panel-border) bg-background p-0 text-sm text-foreground backdrop:bg-black/40 compact:h-dvh compact:w-full compact:border-0 ${className}`}
    >
      {children}
    </dialog>
  );
}
