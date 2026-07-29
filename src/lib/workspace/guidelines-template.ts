// The shape of a brand guidelines document. Two consumers depend on these
// headings agreeing: the URL analyzer is asked to produce them, and the editor
// seeds an empty workspace with them — so an imported document and a
// hand-written one look like the same artifact.
export const GUIDELINES_HEADINGS = [
  "Voice and tone",
  "Do",
  "Don't",
  "How we structure updates",
  "Words and phrases we use",
] as const;

/**
 * Seeded into the editor when a workspace has no guidelines yet, so people edit
 * rather than face a blank page. Deliberately not written to the database on
 * load — the column stays null until the user saves, which is what lets the
 * prompt builders tell "never configured" apart from "configured".
 */
export const GUIDELINES_TEMPLATE = `## Voice and tone

How should updates sound? Formal or casual, playful or plain.

## Do

- Things every update should do.

## Don't

- Things updates should never do.

## How we structure updates

Typical length, sections, and how an update opens and closes.

## Words and phrases we use

Vocabulary that sounds like us, and terms to avoid.
`;
