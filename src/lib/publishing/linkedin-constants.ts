// Client-safe constants for LinkedIn post copy. This module has NO
// server-only imports (no `ai` SDK, no `@/db`, no "use server"), so it's
// safe to import from a "use client" component. `src/lib/ai/linkedin-copy.ts`
// (which does pull in the server-only `ai` SDK via `generateObject`)
// re-exports this same constant so there is a single source of truth —
// importing it there instead of duplicating the value keeps the prompt's
// stated cap and the UI's displayed cap from drifting apart.
export const LINKEDIN_MAX_CHARS = 2900;
