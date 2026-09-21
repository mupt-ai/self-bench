import { type RefObject, useEffect, useRef } from "react";

export function useModalDialog(initialFocus: RefObject<HTMLElement | null>) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    const previousFocus = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    element?.showModal();
    document.body.style.overflow = "hidden";
    initialFocus.current?.focus();
    const restore = () => {
      document.body.style.overflow = previousOverflow;
    };
    element?.addEventListener("close", restore);
    return () => {
      element?.removeEventListener("close", restore);
      element?.close();
      restore();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, [initialFocus]);
  return dialog;
}
