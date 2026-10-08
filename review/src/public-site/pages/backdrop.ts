import type { MouseEvent } from "react";

/**
 * Whether a pointer event on a modal `<dialog>` landed on the page around it. The page is the
 * dialog's backdrop, whose clicks land on the dialog itself; one inside the dialog lands on what
 * it is over, or on the dialog within its box.
 */
export function onBackdrop(event: MouseEvent<HTMLDialogElement>): boolean {
  const box = event.currentTarget.getBoundingClientRect();
  return (
    event.target === event.currentTarget &&
    (event.clientX < box.left ||
      event.clientX > box.right ||
      event.clientY < box.top ||
      event.clientY > box.bottom)
  );
}
