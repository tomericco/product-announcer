"use client";

import { useState } from "react";
import { LINKEDIN_MAX_CHARS } from "@/lib/publishing/linkedin-constants";
import { generateLinkedinCopyAction, saveLinkedinCopyAction } from "./linkedin-actions";

export function LinkedinPanel({
  releaseId,
  initialBody,
  baseUrl,
  slug,
}: {
  releaseId: string;
  initialBody: string;
  baseUrl: string;
  slug: string;
}) {
  const [body, setBody] = useState(initialBody);
  const link = `${baseUrl}${slug}`;
  const overLimit = body.length > LINKEDIN_MAX_CHARS;

  return (
    <section className="space-y-2 rounded border p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">LinkedIn post</h2>
        <form action={generateLinkedinCopyAction}>
          <input type="hidden" name="releaseId" value={releaseId} />
          <button type="submit" className="text-sm underline">
            {initialBody ? "Regenerate" : "Generate"}
          </button>
        </form>
      </div>
      <form action={saveLinkedinCopyAction} className="space-y-2">
        <input type="hidden" name="releaseId" value={releaseId} />
        <textarea
          name="linkedinBody"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={8}
          className="w-full rounded border p-2 text-sm"
        />
        <p className={`text-xs ${overLimit ? "text-destructive" : "text-muted-foreground"}`}>
          {body.length}/{LINKEDIN_MAX_CHARS} characters · link appended: {link}
        </p>
        <button type="submit" className="rounded bg-primary px-3 py-1 text-sm text-primary-foreground">
          Save
        </button>
      </form>
    </section>
  );
}
