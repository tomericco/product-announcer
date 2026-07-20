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
  /**
   * Each editable field reports itself under its own key, comparing against the
   * value it started from — so reverting an edit clears the warning rather than
   * leaving it armed.
   */
  setSectionDirty: (key: string, dirty: boolean) => void;
  /**
   * Bumped whenever edits are committed. Fields watch it to re-baseline against
   * what was just saved; without that, reverting to the originally-loaded text
   * after a save would look clean when it actually differs from the server.
   */
  cleanToken: number;
};

const UnsavedChangesContext = createContext<UnsavedChanges>({
  isDirty: false,
  setSectionDirty: () => {},
  cleanToken: 0,
});

export function UnsavedChangesProvider({ children }: { children: ReactNode }) {
  const [sections, setSections] = useState<Record<string, boolean>>({});
  const [cleanToken, setCleanToken] = useState(0);

  const setSectionDirty = useCallback((key: string, dirty: boolean) => {
    // Skip the update when nothing changed, so typing doesn't re-render the
    // whole dashboard shell on every keystroke.
    setSections((prev) => (prev[key] === dirty ? prev : { ...prev, [key]: dirty }));
  }, []);

  const isDirty = useMemo(() => Object.values(sections).some(Boolean), [sections]);

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
    const onSubmit = () => {
      setSections({});
      setCleanToken((token) => token + 1);
    };
    document.addEventListener("submit", onSubmit, true);
    return () => document.removeEventListener("submit", onSubmit, true);
  }, []);

  const value = useMemo(
    () => ({ isDirty, setSectionDirty, cleanToken }),
    [isDirty, setSectionDirty, cleanToken]
  );

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
