"use client";

import dynamic from "next/dynamic";
import { useState } from "react";

const MdxEditor = dynamic(() => import("./mdx-editor"), { ssr: false });

export function DraftBodyEditor({ defaultValue }: { defaultValue: string }) {
  const [body, setBody] = useState(defaultValue);
  return (
    <div className="w-full">
      <input type="hidden" name="body" value={body} />
      <MdxEditor markdown={body} onChange={setBody} />
    </div>
  );
}
