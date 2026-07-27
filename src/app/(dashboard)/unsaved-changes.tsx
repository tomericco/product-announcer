"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
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
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

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
  /**
   * Called after a programmatic save (e.g. the Ask AI modal) that commits edits
   * without submitting a form. Clears all dirty sections and bumps `cleanToken`
   * so fields re-baseline against what was just saved — the same effect the
   * form-submit listener has, but reachable from imperative code paths.
   */
  notifySaved: () => void;
  /**
   * Called by a GuardedLink when the user tries to navigate away with unsaved
   * edits. Opens the shared confirm modal below; on confirm the provider does
   * the client-side navigation itself.
   */
  requestLeave: (href: string) => void;
};

const UnsavedChangesContext = createContext<UnsavedChanges>({
  isDirty: false,
  setSectionDirty: () => {},
  cleanToken: 0,
  notifySaved: () => {},
  requestLeave: () => {},
});

export function UnsavedChangesProvider({ children }: { children: ReactNode }) {
  const [sections, setSections] = useState<Record<string, boolean>>({});
  const [cleanToken, setCleanToken] = useState(0);
  // The destination a GuardedLink wanted to reach, held while the confirm
  // modal is open. Null means the modal is closed.
  const [pendingHref, setPendingHref] = useState<string | null>(null);
  const router = useRouter();

  const setSectionDirty = useCallback((key: string, dirty: boolean) => {
    // Skip the update when nothing changed, so typing doesn't re-render the
    // whole dashboard shell on every keystroke.
    setSections((prev) => (prev[key] === dirty ? prev : { ...prev, [key]: dirty }));
  }, []);

  const notifySaved = useCallback(() => {
    setSections({});
    setCleanToken((token) => token + 1);
  }, []);

  const requestLeave = useCallback((href: string) => setPendingHref(href), []);

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

  // Confirmed "Leave": clear the dirty flags (so the programmatic navigation
  // below isn't itself re-guarded), close the modal, then navigate.
  function confirmLeave() {
    const href = pendingHref;
    setSections({});
    setPendingHref(null);
    if (href) router.push(href);
  }

  const value = useMemo(
    () => ({ isDirty, setSectionDirty, cleanToken, notifySaved, requestLeave }),
    [isDirty, setSectionDirty, cleanToken, notifySaved, requestLeave]
  );

  return (
    <UnsavedChangesContext.Provider value={value}>
      {children}
      <Dialog open={pendingHref !== null} onOpenChange={(open) => !open && setPendingHref(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Leave without saving?</DialogTitle>
            <DialogDescription>{CONFIRM_MESSAGE}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>Stay</DialogClose>
            <Button variant="destructive" onClick={confirmLeave}>
              Leave
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </UnsavedChangesContext.Provider>
  );
}

export function useUnsavedChanges() {
  return useContext(UnsavedChangesContext);
}

/**
 * A Link that confirms first when there are unsaved edits. `onNavigate` only
 * fires for client-side navigation, and its event can cancel it — full page
 * loads are covered by the beforeunload handler above instead. When dirty, the
 * navigation is cancelled and handed to the provider's confirm modal, which
 * performs the navigation itself if the user confirms.
 */
export function GuardedLink(props: ComponentProps<typeof Link>) {
  const { isDirty, requestLeave } = useUnsavedChanges();
  return (
    <Link
      {...props}
      onNavigate={(event) => {
        if (!isDirty) return;
        // All GuardedLink hrefs in the app are plain strings; only those are
        // guarded (a non-string Url would fall through to normal navigation).
        const href = typeof props.href === "string" ? props.href : null;
        if (href) {
          event.preventDefault();
          requestLeave(href);
        }
      }}
    />
  );
}
