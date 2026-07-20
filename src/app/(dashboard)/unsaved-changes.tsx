"use client";

import Link from "next/link";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";

const CONFIRM_MESSAGE = "You have unsaved changes. Leave without saving?";

type UnsavedChanges = {
  isDirty: boolean;
  markDirty: () => void;
  markClean: () => void;
};

const UnsavedChangesContext = createContext<UnsavedChanges>({
  isDirty: false,
  markDirty: () => {},
  markClean: () => {},
});

/**
 * Tracks whether the page has edits that haven't been submitted yet, and warns
 * before they'd be lost. Lives in the dashboard layout so the sidebar links
 * (which are outside the page they'd navigate away from) can read it.
 */
export function UnsavedChangesProvider({ children }: { children: ReactNode }) {
  const [isDirty, setIsDirty] = useState(false);

  const markDirty = useCallback(() => setIsDirty(true), []);
  const markClean = useCallback(() => setIsDirty(false), []);

  // Full page loads: refresh, tab close, external navigation. The browser shows
  // its own standard warning — the text can't be customized, calling
  // preventDefault is just how you opt in.
  useEffect(() => {
    if (!isDirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [isDirty]);

  // Submitting anything (Save, Approve & publish, Reject) commits the edits, so
  // it must not then warn on the navigation that follows.
  useEffect(() => {
    const onSubmit = () => markClean();
    document.addEventListener("submit", onSubmit, true);
    return () => document.removeEventListener("submit", onSubmit, true);
  }, [markClean]);

  const value = useMemo(() => ({ isDirty, markDirty, markClean }), [isDirty, markDirty, markClean]);

  return <UnsavedChangesContext.Provider value={value}>{children}</UnsavedChangesContext.Provider>;
}

export function useUnsavedChanges() {
  return useContext(UnsavedChangesContext);
}

/**
 * A Link that confirms first when there are unsaved edits. `onNavigate` only
 * fires for client-side navigation, and its event can cancel it — full page
 * loads are covered by the beforeunload handler above instead.
 */
export function GuardedLink(props: ComponentProps<typeof Link>) {
  const { isDirty } = useUnsavedChanges();
  return (
    <Link
      {...props}
      onNavigate={(event) => {
        if (isDirty && !window.confirm(CONFIRM_MESSAGE)) event.preventDefault();
      }}
    />
  );
}
