"use client";

import type { ReactNode } from "react";
import { GenerationModal } from "@/components/generation-modal";
import { useBriefDecision } from "../brief-decision";
import { useBriefEditor } from "./use-brief-editor";
import { BriefHeader } from "./brief-header";
import { BriefEditor } from "./brief-editor";

/**
 * Owns both of the editable brief's hooks, because the header's decisions and
 * the editor's unsaved state are not independent: Accept and Dismiss must
 * commit the edits BEFORE they run, or they destroy them.
 *
 * The header and the editor were separate components mounted side by side
 * until that bug was found. They cannot be — `useBriefDecision` needs
 * `useBriefEditor`'s `saveIfDirty`, and a sibling cannot reach it. Everything
 * else about the two components is unchanged; they just take what they need as
 * props now instead of calling the hooks themselves.
 *
 * `children` is the server-rendered badge row, which sits between the header
 * and the title. It stays a Server Component and is passed through rather than
 * reimplemented here.
 */
export function BriefWorkspace({
  briefId,
  canDecide,
  initialTitle,
  initialBody,
  children,
}: {
  briefId: string;
  canDecide: boolean;
  initialTitle: string;
  initialBody: string;
  children?: ReactNode;
}) {
  const editor = useBriefEditor({ briefId, initialTitle, initialBody });
  const decision = useBriefDecision(briefId, { beforeDecide: editor.saveIfDirty });

  return (
    <>
      <BriefHeader briefId={briefId} canDecide={canDecide} decision={decision} />
      {children}
      <BriefEditor initialTitle={initialTitle} initialBody={initialBody} editor={editor} />

      {/* Accepting shows the generation here instead of redirecting to
          `/drafts/[id]`, so the author stays on the brief they just read.
          Mounted OUTSIDE the `canDecide` gate the header uses: the moment the
          accept lands the brief is no longer `new`, and hiding the modal along
          with the buttons that opened it would close it on its own success. */}
      <GenerationModal
        contentPieceId={decision.generatingPieceId}
        onClose={decision.closeGeneration}
      />
    </>
  );
}
