import { useRef, useState } from "react";

/**
 * State of ONE dialog per page that acts on an entity chosen from a list
 * (rename this department, remove that holiday). The list rows only call
 * `show(entity)`; the dialog itself lives at page level, OUTSIDE the rows.
 *
 * Why: a dialog rendered inside a row dies with the row. After a 404/409 the
 * list refreshes behind the dialog and the row may vanish (someone else
 * deleted it): the error would never be seen and focus would fall to
 * <body>. At page level the dialog keeps a snapshot of the entity and stays
 * until the user closes it. (This bug happened twice: CLAUDE.md.)
 *
 * - `session` changes on every `show`: use it as the dialog's `key`, so each
 *   opening starts with a fresh form and a fresh mutation.
 * - `finalFocus` returns focus to the element that opened the dialog if it is
 *   still on the page, or to the page's h1 if it is gone, or about to go:
 *   call `markRemoved()` after deleting the entity, since its row is still
 *   there when the dialog starts closing and only vanishes after the refetch.
 */
export function useEntityDialog<T>() {
  const [state, setState] = useState<{ target: T; session: number } | null>(null);
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLElement | null>(null);
  const removed = useRef(false);

  const show = (target: T) => {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    removed.current = false;
    setState((previous) => ({ target, session: (previous?.session ?? 0) + 1 }));
    setOpen(true);
  };

  const finalFocus = (): HTMLElement | boolean => {
    if (!removed.current && opener.current?.isConnected) {
      return opener.current;
    }
    return document.querySelector<HTMLElement>("#main h1") ?? true;
  };

  return {
    /** The entity of the last opening (kept while the dialog closes). */
    target: state?.target ?? null,
    session: state?.session ?? 0,
    open,
    setOpen,
    show,
    finalFocus,
    markRemoved: () => {
      removed.current = true;
    },
  };
}

export type EntityDialog<T> = ReturnType<typeof useEntityDialog<T>>;
