"use client";

import { createContext, useContext, useMemo, useState, type ReactNode } from "react";

/**
 * Shares "a generation is running" between a card's editor and the Generate
 * band at its bottom.
 *
 * They are separate components on purpose — the band is a `CardFooter` and must
 * be a sibling of `CardContent`, not nested in it — so the flag cannot simply be
 * passed down. It is a context rather than a lifted wrapper because a wrapper
 * element would become `Card`'s single flex child and collapse the gap between
 * the content and the band; a provider renders no DOM at all.
 *
 * What it guards is real. On success the band calls `router.refresh()`, the
 * server value changes, and the page keys the editor on that value (see
 * `company/page.tsx`) — so the editor REMOUNTS. Anything typed while the
 * generation was in flight is discarded without warning, and if the person hit
 * Save first they would write their stale text back over the fresh derivation.
 * Refusing the edit for those few seconds is the honest behaviour.
 *
 * The default value makes `useGenerationLock` safe outside a provider, matching
 * `useUnsavedChanges` — a component rendered without one simply never locks.
 */
type GenerationLock = {
  generating: boolean;
  setGenerating: (generating: boolean) => void;
};

const GenerationLockContext = createContext<GenerationLock>({
  generating: false,
  setGenerating: () => {},
});

export function GenerationLockProvider({ children }: { children: ReactNode }) {
  const [generating, setGenerating] = useState(false);
  const value = useMemo(() => ({ generating, setGenerating }), [generating]);
  return <GenerationLockContext.Provider value={value}>{children}</GenerationLockContext.Provider>;
}

export function useGenerationLock() {
  return useContext(GenerationLockContext);
}
