import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

/**
 * A Server Component may not CALL a function exported from a `"use client"`
 * module. Across the RSC boundary that export is a client *reference*: it can
 * be rendered as a component or passed as a prop, but invoking it throws
 *
 *     Attempted to call publishMarkerRunIds() from the server but
 *     publishMarkerRunIds is on the client.
 *
 * which is what `/ai-visibility/prompts/[promptId]` did on its first real
 * render, having imported a pure helper from the chart component beside it.
 *
 * No unit test could have caught that. Under vitest the directive is inert —
 * the helper is just a function, the jsdom tests called it directly and passed,
 * and `tsc` and `next build` are both silent because the types are fine and the
 * failure is a runtime property of the boundary. Only a browser found it.
 *
 * So this reads the source instead of running it: any lowercase named import
 * (a helper, not a Component) pulled from a local module that declares
 * `"use client"`, by a file that does not, is the bug. Type-only imports are
 * erased before the boundary exists and are fine; `PascalCase` names are
 * components, which is exactly what the boundary is for.
 *
 * The fix is always the same shape: move the pure function into a module with
 * no directive and import it from there — see `sparkline-points.ts`.
 */

const APP = resolve(__dirname, "../../src/app");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(path) ? [path] : [];
  });
}

function isClientModule(path: string): boolean {
  try {
    // The directive must be the first statement, so the head is enough.
    return /^\s*["']use client["']/.test(readFileSync(path, "utf8").slice(0, 200));
  } catch {
    return false;
  }
}

/** Resolve a relative specifier to the file it means, trying each extension. */
function resolveLocal(fromFile: string, specifier: string): string | null {
  const base = specifier.startsWith("@/")
    ? join(APP, "..", specifier.slice(2))
    : resolve(dirname(fromFile), specifier);
  for (const candidate of [`${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Not this extension; try the next.
    }
  }
  return null;
}

describe("the server/client module boundary", () => {
  it("never imports a callable helper from a \"use client\" module into a server file", () => {
    const offenders: string[] = [];

    for (const file of sourceFiles(APP)) {
      if (isClientModule(file)) continue;
      const source = readFileSync(file, "utf8");

      // `import { a, type B, C } from "./x"` — named imports only; a default
      // or namespace import of a client module is a component, which is legal.
      const importRe = /import\s*\{([^}]*)\}\s*from\s*["'](\.[^"']*|@\/[^"']*)["']/g;
      for (const match of source.matchAll(importRe)) {
        const [, names, specifier] = match;
        // `import type { … }` is erased entirely — no runtime binding, no boundary.
        if (/import\s+type\s*\{$/.test(match[0].slice(0, match[0].indexOf("{") + 1).trim())) continue;
        if (/^\s*import\s+type\b/.test(match[0])) continue;

        const target = resolveLocal(file, specifier);
        if (!target || !isClientModule(target)) continue;

        for (const raw of names.split(",")) {
          const name = raw.trim();
          if (!name || name.startsWith("type ")) continue; // inline `type` specifier
          const local = (name.split(/\s+as\s+/).pop() ?? name).trim();
          // PascalCase is a Component — the one thing the boundary exists to carry.
          if (/^[A-Z]/.test(local)) continue;
          offenders.push(`${file.replace(APP, "src/app")} imports ${local} from ${specifier}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
