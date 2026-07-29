# Brand guidelines page

**Date:** 2026-07-29
**Status:** Approved design

## Goal

Replace the scattered brand-style fields with a single markdown document of
communication guidelines, edited in the app with the same WYSIWYG editor used
for drafts, and move it out of Settings into its own top-level page.

Today the brand voice is spread across six columns — `tone`, `reading_level`,
`do_list`, `dont_list`, `example_phrases`, `updates_style_summary` — each with
its own textarea in a card buried under Settings. The shape constrains what a
team can express (there is no room for "how we open an update", "when we link
to docs", "how we talk about breaking changes") and the fragmentation makes it
hard to see the voice as a whole. One document fixes both.

## Decisions

| Decision | Choice | Consequence |
| --- | --- | --- |
| Storage | One nullable `guidelines` text column | Six columns dropped; no structure to keep in sync. |
| Existing data | Discarded, no backfill | Every workspace starts empty and re-imports or writes fresh. |
| URL import | LLM emits markdown directly | `analyzeBrandStyle` returns `{ guidelines, industry }`; no rendering layer. |
| Prompt injection | Verbatim, in a delimited block | No compile step, no cache column, no staleness. |
| Page layout | Doc-first, single save | Industry/personas/import in a panel above one full-width editor. |
| Empty state | Prefilled starter template | Column stays null until first save, so "has guidelines" stays honest. |
| Route | `/brand-guidelines`, last in nav | Configuration, grouped after Integrations. |
| Editor | Extracted shared component | Drafts compose it with their bridges; no behavior change for drafts. |

## Schema

`brand_profiles` gains one column and loses six:

```ts
export const brandProfiles = pgTable("brand_profiles", {
  id: uuid("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  tenantId: uuid("tenant_id").notNull().unique().references(() => tenants.id, { onDelete: "cascade" }),
  // The team's product-update communication guidelines, as Markdown. Null until
  // they save for the first time — the editor shows a starter template instead.
  guidelines: text("guidelines"),
  industry: text("industry"),
  updatesPageUrl: text("updates_page_url"),
  userPersonas: jsonb("user_personas").$type<PersonaRef[]>().notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
```

Dropped: `tone`, `readingLevel`, `doList`, `dontList`, `examplePhrases`,
`updatesStyleSummary`.

The migration is drizzle-generated, pure DDL, no data statements. It still has
to be a migration file rather than a manual change because migrations run
during the Vercel build. Existing style data in those columns is discarded
deliberately — the deploy is a clean break, not a conversion.

## Route and navigation

New route directory `src/app/(dashboard)/brand-guidelines/`. Added to `NAV` in
`src/app/(dashboard)/nav-links.tsx` as the last entry, after Integrations:

```ts
{ href: "/brand-guidelines", label: "Brand guidelines" },
```

Moved out of `src/app/(dashboard)/settings/` into the new directory:

- `industry-select.tsx`
- `personas-editor.tsx`
- `brand-style-import.tsx`
- the `saveBrandProfile` and `importBrandStyleFromUrl` server actions, into a
  new `brand-guidelines/actions.ts`

Both actions revalidate `/brand-guidelines` instead of `/settings`. The
`splitList` helper in `settings/actions.ts` becomes dead once `doList` and
`dontList` are gone and is deleted with them.

Settings keeps workspace name, members, and publishing schedule. Its "Brand
profile" card is removed entirely. The Settings link in the workspace dropdown
is untouched.

### Page composition

`brand-guidelines/page.tsx` is a server component that loads the brand profile
and the persona catalog (the same two queries `settings/page.tsx` runs today),
then renders, top to bottom:

1. The `BrandStyleImport` panel — kept prominent, since with no backfill it is
   the fastest path back to a populated document.
2. A compact bordered block with Industry (`IndustrySelect`) and User personas
   (`PersonasEditor`).
3. The full-width markdown editor.
4. One Save button, submitting all three through the existing `ToastForm`.

The editor's markdown rides in a hidden input, exactly as
`DraftBodyEditor` does, and the page registers a `"guidelines"` section with
the `useUnsavedChanges` provider so navigating away mid-edit warns.

## Reusing the draft editor

`src/app/(dashboard)/drafts/[releaseId]/mdx-editor.tsx` is currently welded to
drafts in two places: it renders `ViewModeBridge` and `AgentEditBridge` inside
`toolbarContents`, and it puts an Ask-AI button in the selection surface. Both
are draft-specific; everything else — the plugin list, the selection-surface
positioning hook, the parse-error banner, the code-block language map — is
generic.

Extract the generic parts to `src/components/markdown/mdx-editor.tsx` with two
optional props:

```tsx
export default function MdxEditor({
  markdown,
  onChange,
  // Rendered inside toolbarContents, i.e. inside the MDXEditor realm — the only
  // place realm-scoped bridges (useCellValue/usePublisher) can legally live.
  realmChildren,
  // Extra buttons appended to the selection popover.
  selectionExtras,
}: {
  markdown: string;
  onChange: (md: string, initialMarkdownNormalize: boolean) => void;
  realmChildren?: React.ReactNode;
  selectionExtras?: React.ReactNode;
})
```

`AgentEditBridge` needs the `MDXEditorMethods` ref that the editor currently
creates internally, and `realmChildren` is constructed by the caller — so
ownership of that ref moves out. The shared component accepts an optional
`editorRef` prop and falls back to an internal ref when it is absent. The
drafts wrapper creates the ref, passes it in, and uses the same ref in its
bridges:

```tsx
const editorRef = useRef<MDXEditorMethods>(null);
<MdxEditor
  markdown={body}
  onChange={handleChange}
  editorRef={editorRef}
  realmChildren={<><ViewModeBridge /><AgentEditBridge editorRef={editorRef} /></>}
  selectionExtras={<AskAiSelectionButton />}
/>
```

Brand guidelines passes neither prop: no view-mode toggle, no Ask AI. Both
consumers load it through `next/dynamic` with `ssr: false`, as drafts do today
— MDXEditor does not server-render.

This is a mechanical extraction. No plugin, positioning, or selection behavior
changes for drafts.

## Prompt wiring

`buildSystemPrompt` in `src/lib/ai/compose-prompt.ts` loses its five style
lines (`tone`, `readingLevel`, `doList`, `dontList`, `examplePhrases`,
`updatesStyleSummary`) and gains one block appended after the industry and
persona lines:

```
Follow these brand writing guidelines, written by the team:
<brand-guidelines>
{guidelines}
</brand-guidelines>
```

Omitted entirely when `guidelines` is null or blank. The document is capped at
`MAX_GUIDELINES_CHARS = 6000`; past that it is truncated with a
`\n…(truncated)` marker, matching how `composeMergePrompt` already handles an
over-long body.

The cap and truncation live in one exported helper in `compose-prompt.ts`, so
both prompt paths share it rather than each growing their own.

`brandRubric` in `src/lib/ai/review-draft.ts` becomes the same document, passed
through that helper, keeping its existing fallback string when there is nothing
configured:

```ts
function brandRubric(brandProfile: BrandProfileRow): string {
  const guidelines = truncateGuidelines(brandProfile.guidelines);
  return guidelines ?? "No specific brand requirements are configured.";
}
```

Every downstream caller — `generation.ts`, `edit.ts`, `edit-release.ts`,
`catch-up.ts`, `run-schedule.ts` — already passes the whole brand profile row
through, so none of them change.

## URL import

`DerivedBrandProfileSchema` in `src/lib/workspace/analyze-brand-style.ts`
collapses to two fields:

```ts
export const DerivedBrandProfileSchema = z.object({
  guidelines: z.string().nullable(),
  industry: z.string().nullable(),
});
```

The analysis system prompt asks for a markdown document organised under the
same headings the starter template uses, and keeps the existing sign-off
detection — a detected signature becomes a `## Sign-off` section quoting it
verbatim, and a deliberate absence of sign-offs becomes a line under
`## Don't`, rather than a `doList`/`dontList` entry.

`importBrandStyleForTenant` in `src/lib/workspace/brand-import.ts` writes
`guidelines`, `industry`, and `updatesPageUrl`. Its empty-derivation guard
simplifies to:

```ts
const isEmptyDerivation = derived.guidelines === null && derived.industry === null;
```

The confirm dialog in `BrandStyleImport` changes its copy from "This replaces
your tone, industry, do/don't, and style summary…" to "This replaces your brand
guidelines and industry with what we derive from the page." Onboarding step 2
is unchanged in UX — same URL field, same skip — it just writes different
columns now.

## Empty state

When `guidelines` is null the editor mounts with a starter template rather than
a blank canvas:

```markdown
## Voice and tone

How should updates sound? Formal or casual, playful or plain.

## Do

- Things every update should do.

## Don't

- Things updates should never do.

## How we structure updates

Typical length, sections, and how an update opens and closes.

## Words and phrases we use

Vocabulary that sounds like us, and terms to avoid.
```

The template lives in `src/lib/workspace/guidelines-template.ts` as an exported
constant so both the page and its tests reference one source.

The column stays null until the user saves. That keeps two things honest: the
prompt builders skip the guidelines block for a workspace that has never
configured anything, rather than feeding the model a document of instructions
about writing guidelines; and the import's "you are about to overwrite" confirm
is only meaningful when there is something to overwrite.

A user who hits Save without editing does store the template verbatim, and the
model then receives its prompts as if they were guidelines. We accept that
rather than diffing against the template on save — it takes a deliberate act to
reach, the resulting instructions are vague rather than harmful, and the
alternative is a comparison that silently discards a document the moment
someone edits it back to something template-shaped.

## Testing

Updated fixtures — every test that builds a `BrandProfileRow` drops the six
fields and gains `guidelines`:

- `tests/lib/workspace/analyze-brand-style.test.ts`
- `tests/lib/workspace/brand-import.test.ts`
- `tests/lib/workspace/brand-profile-columns.test.ts`
- `tests/lib/ai/compose-prompt.test.ts`
- `tests/lib/ai/compose-edit-prompts.test.ts`
- `tests/lib/ai/generation.test.ts`
- `tests/lib/ai/edit.test.ts`
- `tests/lib/ai/edit-release.test.ts`
- `tests/lib/scheduling/run-schedule.test.ts`

New coverage:

- `guidelines` defaults to null and round-trips a markdown string.
- `buildSystemPrompt` includes the `<brand-guidelines>` block with the document
  inside when set.
- `buildSystemPrompt` omits the block when `guidelines` is null, and when it is
  whitespace only.
- `buildSystemPrompt` truncates a document longer than 6000 chars and marks it.
- `brandRubric` returns the document verbatim, and the fallback string when null.
- `importBrandStyleForTenant` persists `guidelines`, and treats a derivation of
  two nulls as empty (writes nothing, returns the reason).
- The starter template constant is non-empty and parses as the headings the
  analysis prompt asks for — a cheap guard against the two drifting apart.

The extracted editor is not unit-tested; MDXEditor is browser-only and the
existing draft editor has no tests either. Verification is `tsc` and `eslint`,
plus manual check of both consumers.

## Out of scope

- Versioning or history for the guidelines document.
- Per-destination guidelines (LinkedIn voice vs. changelog voice).
- Ask AI inside the guidelines editor.
- Any change to how personas or industry themselves work.
