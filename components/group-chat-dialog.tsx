"use client";

import { useEffect, useRef, useState, type RefObject } from "react";

const FOCUSABLE = "a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";

export function useDialogFocus(dialogRef: RefObject<HTMLElement | null>, onClose: () => void) {
  // Captured during the first render: by the time effects run, autoFocus has already moved focus into the dialog.
  const [opener] = useState(() => typeof document === "undefined" ? null : document.activeElement as HTMLElement | null);
  const close = useRef(onClose);
  useEffect(() => { close.current = onClose; });
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.contains(document.activeElement)) dialog.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (!dialog) return;
      if (event.key === "Escape") { event.preventDefault(); close.current(); return; }
      if (event.key !== "Tab") return;
      const items = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (!items.length) return;
      const first = items[0], last = items[items.length - 1], active = document.activeElement;
      if (event.shiftKey ? active === first || !dialog.contains(active) : active === last || !dialog.contains(active)) { event.preventDefault(); (event.shiftKey ? last : first).focus(); }
    };
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("keydown", onKey); if (opener?.isConnected) opener.focus(); };
  }, [dialogRef, opener]);
}
