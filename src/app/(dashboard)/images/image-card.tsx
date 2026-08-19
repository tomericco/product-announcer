"use client";

import { useState } from "react";
import Image from "next/image";
import { format } from "date-fns";
import { Badge } from "@/components/ui/badge";
import type { ImageRole, ImageSourceKind } from "@/db/schema";
import { ImageDetail } from "./image-detail";

export type LibraryImage = {
  id: string;
  role: ImageRole;
  sourceKind: ImageSourceKind;
  status: string;
  concept: string;
  altText: string;
  contentPieceId: string | null;
  pieceTitle: string | null;
  piecePublished: boolean;
  createdAt: string;
  url: string | null;
  prompt: string;
};

const ROLE_LABEL: Record<ImageRole, string> = { cover: "Cover", body: "Body", library: "Library" };

/** The thumbnail grid plus the one detail dialog it opens (spec §5b Card). */
export function ImageGrid({ images }: { images: LibraryImage[] }) {
  const [selected, setSelected] = useState<LibraryImage | null>(null);
  return (
    <>
      <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
        {images.map((image) => (
          <li key={image.id}>
            <button
              type="button"
              onClick={() => setSelected(image)}
              className="group block w-full space-y-2 rounded-lg border p-2 text-left transition-colors hover:bg-muted/50"
            >
              <div className="relative aspect-[4/3] overflow-hidden rounded-md bg-muted">
                {image.url ? (
                  <Image src={image.url} alt={image.altText} fill sizes="(min-width: 1024px) 25vw, 50vw" className="object-cover" />
                ) : (
                  <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                    {image.status === "failed" ? "Generation failed" : "Generating…"}
                  </div>
                )}
              </div>
              <p className="line-clamp-2 text-sm">{image.concept || "Untitled image"}</p>
              <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
                <Badge variant="outline">{ROLE_LABEL[image.role]}</Badge>
                {image.sourceKind === "uploaded" && <Badge variant="outline">Uploaded</Badge>}
                <span className="ml-auto">{format(new Date(image.createdAt), "d MMM yyyy")}</span>
              </div>
              {image.pieceTitle && <p className="truncate text-xs text-muted-foreground">{image.pieceTitle}</p>}
            </button>
          </li>
        ))}
      </ul>
      {/* `key={selected?.id}` remounts ImageDetail whenever the selection
          changes, so its internal state (view/current/lookup) starts fresh
          for the new image without a synchronous setState-in-effect reset —
          see the comment in image-detail.tsx. */}
      <ImageDetail key={selected?.id ?? "none"} image={selected} onClose={() => setSelected(null)} />
    </>
  );
}
