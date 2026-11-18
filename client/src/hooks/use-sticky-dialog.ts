import { useRef, useState } from "react";

interface StickyDialogOptions {
  /** While true (e.g. a mutation in flight) the dialog refuses to close: it may still fail. */
  isBusy: boolean;
  /** Runs each time the dialog opens: reset the form and the mutation here. */
  onOpen?: () => void;
}

/**
 * State for an action dialog (cancel, approve, reject) whose trigger can
 * disappear while it is open: the API may answer with permissions that no
 * longer offer the action, either after success or after a 409/403 refresh.
 *
 * - `active` stays true from opening until the close animation ends, so the
 *   caller keeps the dialog mounted (`if (!allowed && !active) return null`)
 *   and an error stays readable instead of vanishing with the trigger.
 * - `finalFocus` returns focus to the trigger as usual, or to the page's
 *   `h1` when the trigger is gone, instead of letting it fall to <body>.
 */
export function useStickyDialog({ isBusy, onOpen }: StickyDialogOptions) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(false);
  // Set on success: the trigger is about to disappear even if it is still
  // connected when the dialog starts closing.
  const succeeded = useRef(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const onOpenChange = (nextOpen: boolean) => {
    if (!nextOpen && isBusy) {
      return;
    }
    if (nextOpen) {
      succeeded.current = false;
      onOpen?.();
      setActive(true);
    }
    setOpen(nextOpen);
  };

  const onOpenChangeComplete = (isOpen: boolean) => {
    if (!isOpen) setActive(false);
  };

  const finalFocus = (): HTMLElement | boolean => {
    const triggerGone = succeeded.current || !triggerRef.current?.isConnected;
    return (triggerGone && document.querySelector<HTMLElement>("#main h1")) || true;
  };

  /** Call from the mutation's onSuccess. */
  const closeAfterSuccess = () => {
    succeeded.current = true;
    setOpen(false);
  };

  return {
    active,
    triggerRef,
    finalFocus,
    closeAfterSuccess,
    rootProps: { open, onOpenChange, onOpenChangeComplete },
  };
}
