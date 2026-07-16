"use client";

import dynamic from "next/dynamic";
import { useState } from "react";
import "@uiw/react-md-editor/markdown-editor.css";

const MDEditor = dynamic(() => import("@uiw/react-md-editor"), { ssr: false });

export function DraftBodyEditor({ defaultValue }: { defaultValue: string }) {
  const [body, setBody] = useState(defaultValue);
  return (
    <div data-color-mode="light">
      <input type="hidden" name="body" value={body} />
      <MDEditor value={body} onChange={(v) => setBody(v ?? "")} height={300} />
    </div>
  );
}
