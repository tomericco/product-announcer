# versional — Brand Style Guide

Reference for the visual system. Derived from [Attio](https://attio.com) as a structural reference,
with a deliberately divergent accent.

## Principles

1. **Ink on bright, not white on mid-tone.** The accent is high-lightness and high-chroma, so it
   cannot carry white text. Filled surfaces use near-black ink on chartreuse. This inversion is the
   signature of the system — do not "fix" it by darkening the accent to fit white text.
2. **Warm neutrals, never pure grey.** Every neutral carries a low-chroma warm hue (~90–95). Pure
   `oklch(x 0 0)` greys read as an unstyled scaffold.
3. **Colour is structural, not decorative.** Chartreuse marks *the primary action, the current
   location, and state*. It never appears as ornament.
4. **Crisp over soft.** 1px borders, small radii, minimal shadow. Density over padding.

## Colour

### Accent — Acid Chartreuse

| Token | Light | Purpose |
| --- | --- | --- |
| `--brand` | `oklch(0.885 0.185 116)` (#D2E830) | Filled surfaces: primary buttons, badges, switch-on |
| `--brand-ink` | `oklch(0.44 0.105 112)` | Accent-coloured **text and borders** on light backgrounds |
| `--brand-subtle` | `oklch(0.965 0.045 115)` | Chip and active-nav backgrounds |
| `--brand-subtle-foreground` | `oklch(0.42 0.10 112)` | Text on `--brand-subtle` |

`--brand` and `--brand-ink` are not interchangeable. Chartreuse at L 0.885 against white is roughly
1.2:1 — invisible as text. Any accent-coloured glyph, label, or border uses `--brand-ink`.

`--primary` is mapped to `--brand` and `--primary-foreground` to ink, so shadcn's `default` button
and badge variants pick the accent up with no per-component changes.

### Neutrals

Warm, tuned toward yellow (hue ~90–95) so they sit under the chartreuse rather than fighting it.
Cards stay pure white to lift off the warm page.

### Semantic collisions

Yellow-green carries no warning semantics in this system — `--destructive` owns all error and
danger states. Do not introduce an amber warning colour; it would read as a dimmer brand accent.

## Radius

`--radius: 0.5rem`, yielding **4.8 / 6.4 / 8px** at sm/md/lg — within a hair of Attio's measured
4/6/8. Every component derives from this; do not hardcode radii.

## Typography

| Role | Face | Treatment |
| --- | --- | --- |
| Page titles | **Instrument Serif** (`font-heading`) | 400, `text-3xl`, `leading-[1.15]`, `tracking-[0.015em]` |
| Sign-in hero | **Instrument Serif** (`font-heading`) | as above at `text-4xl` |
| Body & UI | **Inter** (`font-sans`) | Default |
| Wordmark | **Caveat 700** (`font-script`) | Logo lockup only — never body, UI, or headings |
| Code | Geist Mono (`font-mono`) | Default |

**Track the serif positive, never tight.** Attio's measured `-0.02em` was taken from Inter Display,
a grotesque sans. Instrument Serif is narrow and tightly fitted already, so negative tracking
compounds and the letterforms collide. `tracking-tight` on `font-heading` is always a bug.

**The serif is for page-level titles only** — the five dashboard page headings, the sign-in hero,
and onboarding. Not card titles, dialog titles, empty states, table headers, buttons, or section
labels. Overuse destroys the contrast that makes it work, and at `text-base` this face turns
spindly.

> **Gotcha.** `--font-heading` used to be an alias for the body sans, which made `font-heading` a
> no-op — so `card.tsx`, `dialog.tsx`, and `empty-state.tsx` all carried it harmlessly. Pointing the
> token at a real display face silently converted every card and dialog title to serif. Those three
> are now pinned to `font-sans`. Before adding `font-heading` anywhere, confirm the element is a
> page-level title.

**Never apply the serif to `.mdx-content`.** Those headings are the user's draft content, which is
published to Webflow, LinkedIn, and Notion. Styling it in our brand face would misrepresent how it
renders at its destination.

## Logo

A handwritten chartreuse "v" on a fixed dark tile, beside a Caveat wordmark. Exported from
`src/components/brand/logo.tsx` as `<Mark />` (glyph only) and `<Logo />` (mark + wordmark).

The script is the third type family in the system, after Inter and Instrument Serif. That is
deliberate and confined to the logo — a wordmark conventionally gets its own face. It buys nothing
anywhere else, so `font-script` must never appear outside this component.

**The glyph is an outlined path, defined once.** `src/components/brand/mark-path.ts` holds the path,
stroke width, and tile fill; `<Mark />` imports them and `src/app/icon.svg` inlines the same literals.
The favicon cannot set the letter in Caveat — favicons render without webfonts and would fall back
to a system face — so the duplication is unavoidable, but
`tests/components/brand/mark-path.test.ts` fails if the two diverge. Edit both together.

**The glyph sits low and right on purpose** — roughly x 10.7–17.1, y 10.0–17.3 on the 24×24 tile,
not centred. It looks like a `text-anchor` side-bearing accident and is not one. Do not recentre it;
the test pins the placement.

Two further traps, both of which bit once already:

- **A drawn approximation is not the letter.** The first favicon was a geometric "V" spanning the
  whole tile; Caveat's is a small lowercase "v" in the x-height band that leans right. Fit any
  redraw by rasterising the real glyph and matching its measured ink box, not by eye.
- **Stroke weight is set independently of scale.** A filled letterform keeps its weight when shrunk;
  a stroked path does not. Scaling the stroke proportionally with the glyph put it under a pixel
  wide at favicon size.

**`src/app/favicon.ico` must not exist.** Next.js's metadata convention gives `favicon.ico`
precedence over `icon.svg`, so the scaffold's default icon silently wins and the brand mark never
ships. It was deleted for exactly this reason.

**A broken favicon fails silently.** `icon.svg` is parsed as strict XML: one malformed character and
the browser renders no icon, with no console error and no failed request — it looks exactly like a
caching problem. The trap that actually hit was a doubled hyphen inside an XML comment, which is
illegal and aborts the parse. The test suite now checks well-formedness; if the icon disappears,
run it before suspecting cache.

Browsers also cache favicons far more aggressively than other assets. After a change, verify in a
hard reload or a fresh tab rather than the tab you have open.

**The tile is structural, not decorative.** Principle 1 applies to the logo too: an unbacked
chartreuse stroke on a light page is ~1.2:1 and vanishes, collapsing the "v" into a single stroke.
The tile is what lets the accent stay bright, and it is why the tile colour is hardcoded rather than
bound to `--foreground` — that token inverts between modes and would erase the glyph in dark.

## Applying the accent

| Use | Treatment |
| --- | --- |
| Primary button | `--brand` fill, ink text |
| Secondary / cancel | `outline` or `ghost` — never accent |
| Destructive | `--destructive`, unchanged |
| Active nav item | `--brand-subtle` background, `--brand-subtle-foreground` text |
| Status chip | `--brand` fill for the live/primary state; neutral for the rest |
| Focus ring | `--ring` (deep chartreuse, darkened for visibility) |

One accent-filled button per screen region. If two buttons in a row are both chartreuse, one of
them is not actually primary.
