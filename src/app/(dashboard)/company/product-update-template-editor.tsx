"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";
import { useUnsavedChanges } from "../unsaved-changes";
import { useGenerationLock } from "./generation-lock";
import { DEFAULT_PRODUCT_UPDATE_TEMPLATE } from "@/lib/workspace/product-update-template";

const MdxEditor = dynamic(() => import("@/components/markdown/mdx-editor"), { ssr: false });

export function ProductUpdateTemplateEditor({ defaultValue }: { defaultValue: string | null }) {
  // A workspace with nothing stored edits the template rather than a blank
  // page. Nothing is written until they save, so the column stays null and the
  // prompt builders can still tell "never configured" from "configured".
  const initial = defaultValue ?? DEFAULT_PRODUCT_UPDATE_TEMPLATE;
  const [template, setTemplate] = useState(initial);
  const { setSectionDirty, cleanToken } = useUnsavedChanges();
  // Frozen while the Generate band below is running: on success the page
  // remounts this editor with the derived value, so an edit typed now would be
  // silently discarded.
  const { generating } = useGenerationLock();
  const baseline = useRef(initial);
  const latest = useRef(initial);
  // Sticky once true: distinguishes "the user actually edited this field" from
  // "this is still the seeded template nobody touched". Only ever flips
  // false -> true (see onChange below) -- a user who edits the template and
  // then reverts back to it has still engaged with the field, and saving the
  // template in that case is fine.
  const [touched, setTouched] = useState(false);

  // Re-baseline once edits are committed, so a later revert is measured against
  // what was saved rather than what was originally loaded.
  useEffect(() => {
    baseline.current = latest.current;
  }, [cleanToken]);

  // Clear this field's flag when the page unmounts, so navigating away can't
  // leave a stale warning armed on another page.
  useEffect(() => () => setSectionDirty("productUpdateTemplate", false), [setSectionDirty]);

  // While a fresh workspace is still showing the untouched seeded template,
  // submit "" rather than the template text. `saveProductUpdateTemplate` turns
  // an empty submission into `productUpdateTemplate: null`, which is
  // deliberate: it's what keeps the column null until the user actually writes
  // something, so the composer/reviewer can keep telling "never configured"
  // apart from "configured". Do not "simplify" this back to submitting
  // `template` directly -- that would permanently persist the placeholder
  // skeleton the first time the user saves anything else on the page (e.g.
  // just Industry).
  const submittedValue = defaultValue === null && !touched ? "" : template;

  return (
    <div className="w-full">
      <input
        type="hidden"
        name="productUpdateTemplate"
        data-testid="product-update-template-input"
        value={submittedValue}
      />
      <MdxEditor
        readOnly={generating}
        markdown={template}
        contentEditableClassName="min-h-[50vh]"
        placeholder={<span className="text-muted-foreground/40">Product update template</span>}
        onChange={(md, initialMarkdownNormalize) => {
          setTemplate(md);
          latest.current = md;

          // On mount the editor rewrites the stored markdown into its own
          // dialect (bullet characters, escaping, whitespace). That isn't a user
          // edit — it's the resting state — so it becomes the baseline instead
          // of counting as a change.
          if (initialMarkdownNormalize) {
            baseline.current = md;
            setSectionDirty("productUpdateTemplate", false);
            return;
          }

          const dirty = md !== baseline.current;
          setSectionDirty("productUpdateTemplate", dirty);
          if (dirty) setTouched(true);
        }}
      />
    </div>
  );
}
