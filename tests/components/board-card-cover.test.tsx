import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { BoardCard } from "../../src/lib/content/board";

/**
 * The cover on a board card (spec §3). Mounts the real `BoardCardItem`
 * rather than asserting on class strings, because what can break here is
 * wiring: an image that is not `Card`'s first child gets neither the flush
 * top nor the rounded corners, and a coverless card that renders an empty
 * frame is a regression on every product update and social post.
 *
 * Mocked for the same reasons `board-briefs.test.tsx` gives (lines 22-45):
 * the `"use server"` modules the card imports each reach `@/db`, which opens
 * a `pg` Pool at import time and the jsdom project has no DATABASE_URL;
 * `next/navigation` has no router outside an app render; and `@dnd-kit`'s
 * `useDraggable` has no measurable rect in jsdom.
 *
 * `next/image` is stubbed to a prop-forwarding `<img>`: outside a Next build
 * its loader has no image config, and the assertions below are about what
 * this card asks for (a 1200x630 box, an empty alt, an uncropped fit), not
 * about Next's optimizer.
 */
vi.mock("../../src/app/(dashboard)/board/actions", () => ({
  moveCard: vi.fn(),
  assignCard: vi.fn(),
  acceptBriefCard: vi.fn(),
  deleteCard: vi.fn(),
  deleteBriefCard: vi.fn(),
}));
vi.mock("../../src/app/(dashboard)/briefs/actions", () => ({ generateDraft: vi.fn() }));
vi.mock("../../src/app/(dashboard)/progress-actions", () => ({ pollGenerationProgress: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@dnd-kit/core", () => ({
  useDraggable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: () => {},
    transform: null,
    isDragging: false,
  }),
}));
vi.mock("next/image", () => ({
  default: (props: Record<string, unknown>) => {
    const { src, alt, ...rest } = props as { src: string; alt: string };
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={src} alt={alt} {...rest} />;
  },
}));

import { BoardCardItem } from "../../src/app/(dashboard)/board/card";

const BARE: BoardCard = {
  kind: "piece",
  id: "piece-1",
  title: "Search got faster",
  type: "blog_post",
  status: "draft",
  assignedTo: null,
  scheduledFor: null,
  generationError: null,
  generatedAt: null,
  generationStep: null,
  createdAt: new Date("2026-08-01T00:00:00Z"),
  cover: null,
};

const COVERED: BoardCard = {
  ...BARE,
  cover: { url: "https://blob.example/cover-1.png", alt: "Lighthouse beam over a grid of tiles" },
};

function renderCard(card: BoardCard) {
  return render(
    <BoardCardItem
      card={card}
      members={[]}
      draggable
      onGenerated={() => {}}
      onAssigned={() => {}}
      onDelete={() => {}}
    />
  );
}

describe("a card whose piece has a cover", () => {
  it("renders the cover as the card's first child, which is what the flush-top rule keys on", () => {
    const { container } = renderCard(COVERED);
    const card = container.querySelector('[data-slot="card"]');
    expect(card).not.toBeNull();
    // `has-[>img:first-child]:pt-0` and `*:[img:first-child]:rounded-t-xl`
    // (src/components/ui/card.tsx:16) match a DIRECT first-child <img> only —
    // put the image after CardContent, or inside it, and both silently stop.
    expect(card!.firstElementChild?.tagName).toBe("IMG");
    expect(card!.querySelector("img")?.getAttribute("src")).toBe("https://blob.example/cover-1.png");
  });

  it("asks for the cover's native 1200x630 and never crops it", () => {
    const { container } = renderCard(COVERED);
    const img = container.querySelector("img")!;
    // The real render size. With width/height set, the browser reserves the
    // 1.91:1 box before the bytes arrive — no layout shift on load.
    expect(img.getAttribute("width")).toBe("1200");
    expect(img.getAttribute("height")).toBe("630");
    // Product owner decision 1: nothing in this plan crops or letterboxes.
    expect(img.className).toContain("h-auto");
    expect(img.className).not.toContain("object-cover");
  });

  it("gives the cover an empty alt — the linked title is the card's name", () => {
    const { container } = renderCard(COVERED);
    // Spec §2: decorative images get empty alt. The description stored on the
    // row is what publishing uses; announcing it above every title here would
    // read the artwork of the whole board before any of its work.
    expect(container.querySelector("img")!.getAttribute("alt")).toBe("");
    expect(screen.getByRole("link", { name: "Search got faster" })).toBeInTheDocument();
  });
});

describe("a card whose piece has no cover", () => {
  it("renders no image and no placeholder for it", () => {
    const { container } = renderCard(BARE);
    // Most pieces are in this state (product updates, social posts, and any
    // piece whose cover generation failed). Their cards must be exactly what
    // they are today: CardContent first, no frame, no reserved gap.
    expect(container.querySelector("img")).toBeNull();
    const card = container.querySelector('[data-slot="card"]')!;
    expect(card.firstElementChild?.getAttribute("data-slot")).toBe("card-content");
  });
});
