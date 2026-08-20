"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import { Loader2, Plus, Sparkles, X } from "lucide-react";
import { toast } from "sonner";
import { saveVisualIdentity, deriveVisualIdentityFromUrl, removeStyleReference, uploadStyleReference } from "./actions";
import { useUnsavedChanges } from "../unsaved-changes";
import type { ImageRule, PaletteRole, VisualIdentity } from "@/db/schema";
import {
  BACKGROUND_TREATMENTS,
  DEFAULT_VISUAL_IDENTITY,
  MAX_CUSTOM_DESCRIPTORS,
  MAX_PALETTE,
  MAX_REFERENCE_IMAGES,
  MIN_READY_PALETTE,
  PALETTE_ROLES,
  PEOPLE_STYLES,
  STYLE_PRESETS,
  TEXTURES,
} from "@/lib/images/visual-identity";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const EMPTY: VisualIdentity = { ...DEFAULT_VISUAL_IDENTITY, palette: [] };

function labelOf<T extends string>(options: readonly { value: T; label: string }[], value: T): string {
  return options.find((o) => o.value === value)?.label ?? value;
}

/**
 * The Visual identity card (image spec §2). Owns its own Save like every card
 * on /company. "Derive from website" only prefills — nothing is written until
 * Save — so the derive button needs no confirm dialog, unlike
 * BrandStyleImport, which overwrites on the server.
 *
 * The one exception to card-owns-its-save: style reference images upload and
 * delete immediately (a blob exists the moment it is uploaded), so those two
 * actions re-baseline the dirty tracking from the list they return.
 */
export function VisualIdentityEditor({
  initial,
  defaultWebsiteUrl,
}: {
  initial: VisualIdentity | null;
  defaultWebsiteUrl: string;
}) {
  const [identity, setIdentity] = useState<VisualIdentity>(initial ?? EMPTY);
  const [saved, setSaved] = useState<VisualIdentity>(initial ?? EMPTY);
  const [moodText, setMoodText] = useState((initial ?? EMPTY).moodWords.join(", "));
  const [saving, setSaving] = useState(false);
  const [deriving, setDeriving] = useState(false);
  // ok: true renders emerald (BrandStyleImport's success idiom); failures muted.
  const [derivedNote, setDerivedNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [url, setUrl] = useState(defaultWebsiteUrl);
  const [advanced, setAdvanced] = useState(false);
  const [uploadingReference, setUploadingReference] = useState(false);
  const referenceInputRef = useRef<HTMLInputElement>(null);
  const { setSectionDirty } = useUnsavedChanges();

  const dirty = JSON.stringify(identity) !== JSON.stringify(saved);
  useEffect(() => {
    setSectionDirty("visual-identity", dirty);
  }, [dirty, setSectionDirty]);
  useEffect(() => () => setSectionDirty("visual-identity", false), [setSectionDirty]);

  const update = (patch: Partial<VisualIdentity>) => setIdentity((v) => ({ ...v, ...patch }));

  // Mood words are one comma-separated field; parsed on every keystroke so
  // the saved list is always what the box shows.
  const setMood = (text: string) => {
    setMoodText(text);
    update({ moodWords: text.split(",").map((w) => w.trim()).filter(Boolean).slice(0, 4) });
  };

  const setPaletteEntry = (i: number, patch: Partial<{ hex: string; role: PaletteRole }>) =>
    update({ palette: identity.palette.map((p, j) => (j === i ? { ...p, ...patch } : p)) });
  const addColor = () => {
    if (identity.palette.length >= MAX_PALETTE) return;
    const nextRole = PALETTE_ROLES[identity.palette.length % PALETTE_ROLES.length].value;
    update({ palette: [...identity.palette, { hex: "#000000", role: nextRole }] });
  };
  const removeColor = (i: number) => update({ palette: identity.palette.filter((_, j) => j !== i) });

  const setRule = (i: number, patch: Partial<ImageRule>) =>
    update({ imageGenerationRules: identity.imageGenerationRules.map((r, j) => (j === i ? { ...r, ...patch } : r)) });
  const addRule = (kind: ImageRule["kind"]) => update({ imageGenerationRules: [...identity.imageGenerationRules, { kind, text: "" }] });
  const removeRule = (i: number) => update({ imageGenerationRules: identity.imageGenerationRules.filter((_, j) => j !== i) });

  /**
   * Reference images are uploaded, not typed (product owner decision 3), and
   * both actions persist immediately — so the returned list becomes the new
   * baseline on BOTH `identity` and `saved`, or the card would either look
   * dirty for a change already stored, or overwrite the stored list on the
   * next Save.
   */
  const applyReferences = (styleReferenceImages: string[]) => {
    setIdentity((v) => ({ ...v, styleReferenceImages }));
    setSaved((v) => ({ ...v, styleReferenceImages }));
  };

  async function addReferenceFiles(files: File[]) {
    if (files.length === 0 || uploadingReference) return;
    setUploadingReference(true);
    try {
      // One at a time: the action enforces the cap of MAX_REFERENCE_IMAGES and
      // the message for the one that doesn't fit should name that, not fail
      // the whole drop.
      for (const file of files) {
        const fd = new FormData();
        fd.set("file", file);
        const res = await uploadStyleReference(fd);
        if (!res.ok) {
          toast.error(res.error);
          break;
        }
        applyReferences(res.styleReferenceImages);
      }
    } catch {
      toast.error("Couldn't upload that image — try again");
    } finally {
      setUploadingReference(false);
    }
  }

  async function removeReference(url: string) {
    try {
      const res = await removeStyleReference(url);
      if (res.ok) applyReferences(res.styleReferenceImages);
      else toast.error(res.error);
    } catch {
      toast.error("Couldn't remove that image — try again");
    }
  }

  async function derive() {
    const trimmed = url.trim();
    if (!trimmed || deriving) return;
    setDeriving(true);
    setDerivedNote(null);
    try {
      const res = await deriveVisualIdentityFromUrl(trimmed);
      if (res.ok) {
        // Keep the uploaded references: they are already stored (and paid for
        // on Blob), and a derived proposal has nothing to say about them.
        setIdentity({ ...res.identity, styleReferenceImages: identity.styleReferenceImages });
        setMoodText(res.identity.moodWords.join(", "));
        setDerivedNote({ ok: true, text: "Proposed from your site — review below and Save to keep it." });
      } else {
        setDerivedNote({ ok: false, text: "We couldn't derive an identity from that page — check the URL or fill in the palette by hand." });
      }
    } finally {
      setDeriving(false);
    }
  }

  async function save() {
    setSaving(true);
    try {
      // Drop blank rules before validating; a half-typed rule is not an
      // invalid identity. Reference images need no cleaning — they are blob
      // URLs written by their own actions, never typed.
      const clean: VisualIdentity = {
        ...identity,
        imageGenerationRules: identity.imageGenerationRules.filter((r) => r.text.trim()),
      };
      const res = await saveVisualIdentity(clean);
      if (res.ok) {
        setIdentity(clean);
        setSaved(clean);
        setDerivedNote(null);
        toast.success("Visual identity saved");
      } else {
        toast.error("Check the palette (hex like #1a73e8), then try again");
      }
    } catch {
      toast.error("Couldn't save visual identity — try again");
    } finally {
      setSaving(false);
    }
  }

  const ready = identity.palette.length >= MIN_READY_PALETTE;

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <Label>Derive from your website</Label>
        <div className="flex gap-2">
          <Input type="url" placeholder="https://yourcompany.com" value={url} onChange={(e) => setUrl(e.target.value)} className="flex-1" />
          <Button type="button" variant="outline" onClick={derive} disabled={deriving || !url.trim()}>
            {deriving ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
            {deriving ? "Analyzing…" : "Derive"}
          </Button>
        </div>
        {derivedNote && (
          <p className={derivedNote.ok ? "text-xs text-emerald-600" : "text-xs text-muted-foreground"}>{derivedNote.text}</p>
        )}
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label>Palette</Label>
          <span className="text-xs text-muted-foreground">
            {ready ? `${identity.palette.length} of ${MAX_PALETTE}` : `Add at least ${MIN_READY_PALETTE} colors to enable image generation`}
          </span>
        </div>
        {identity.palette.map((p, i) => (
          <div key={i} className="flex items-center gap-2">
            <input
              type="color"
              aria-label={`Color ${i + 1}`}
              value={/^#[0-9a-fA-F]{6}$/.test(p.hex) ? p.hex : "#000000"}
              onChange={(e) => setPaletteEntry(i, { hex: e.target.value })}
              className="size-9 cursor-pointer rounded border border-input bg-transparent p-0.5"
            />
            <Input value={p.hex} onChange={(e) => setPaletteEntry(i, { hex: e.target.value })} className="w-32 font-mono" placeholder="#1a73e8" />
            <Select value={p.role} onValueChange={(v) => setPaletteEntry(i, { role: v as PaletteRole })}>
              <SelectTrigger className="w-40">
                <SelectValue>{labelOf(PALETTE_ROLES, p.role)}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {PALETTE_ROLES.map((r) => (
                  <SelectItem key={r.value} value={r.value}>
                    {r.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button type="button" variant="ghost" size="sm" aria-label="Remove color" onClick={() => removeColor(i)}>
              <X className="size-4" />
            </Button>
          </div>
        ))}
        <Button type="button" variant="outline" size="sm" onClick={addColor} disabled={identity.palette.length >= MAX_PALETTE}>
          <Plus /> Add color
        </Button>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label>Style</Label>
          <Select value={identity.stylePreset} onValueChange={(v) => update({ stylePreset: v as VisualIdentity["stylePreset"] })}>
            <SelectTrigger>
              <SelectValue>{labelOf(STYLE_PRESETS, identity.stylePreset)}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {STYLE_PRESETS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label>Mood words</Label>
          <Input value={moodText} onChange={(e) => setMood(e.target.value)} placeholder="clean, modern" />
          <p className="text-xs text-muted-foreground">Two to four, comma-separated.</p>
        </div>
      </div>

      <Label>
        <Switch checked={identity.allowTextInImages} onCheckedChange={(v) => update({ allowTextInImages: v })} />
        Allow text inside images
      </Label>

      <Button type="button" variant="ghost" size="sm" onClick={() => setAdvanced((a) => !a)}>
        {advanced ? "Hide advanced" : "Advanced…"}
      </Button>

      {advanced && (
        <div className="space-y-5 rounded-md border p-4">
          <div className="space-y-2">
            <Label>Style reference images</Label>
            <p className="text-xs text-muted-foreground">
              Up to {MAX_REFERENCE_IMAGES} images you already use; every generated image is steered toward them. PNG, JPEG or WebP,
              10 MB or smaller. These save as soon as they upload.
            </p>
            {identity.styleReferenceImages.length > 0 && (
              <ul className="flex flex-wrap gap-2">
                {identity.styleReferenceImages.map((ref) => (
                  <li key={ref} className="group relative">
                    {/* Style references are stored in the private brand-assets
                        store (the browser has no Blob token), so the thumbnail
                        goes through the authenticated proxy route rather than
                        the raw blob URL. */}
                    <Image
                      src={`/api/brand-assets?url=${encodeURIComponent(ref)}`}
                      alt=""
                      width={96}
                      height={72}
                      className="h-[72px] w-24 rounded border object-cover"
                      unoptimized
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      aria-label="Remove image"
                      className="absolute right-0 top-0 bg-background/80"
                      onClick={() => void removeReference(ref)}
                    >
                      <X className="size-4" />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            {/* A hidden file input behind a Button: the app has no file-input
                primitive, and a bare <input type="file"> would be the only
                unstyled control on the page. */}
            <input
              ref={referenceInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              multiple
              className="hidden"
              onChange={(e) => {
                // Copy out of the live FileList before clearing the input, so
                // picking the same file twice in a row still fires a change.
                const files = Array.from(e.target.files ?? []);
                e.target.value = "";
                void addReferenceFiles(files);
              }}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => referenceInputRef.current?.click()}
              disabled={uploadingReference || identity.styleReferenceImages.length >= MAX_REFERENCE_IMAGES}
            >
              {uploadingReference ? <Loader2 className="size-4 animate-spin" /> : <Plus />}
              {uploadingReference ? "Uploading…" : "Add image"}
            </Button>
          </div>

          <div className="space-y-2">
            <Label>Custom style descriptors</Label>
            <Textarea
              rows={2}
              maxLength={MAX_CUSTOM_DESCRIPTORS}
              value={identity.customStyleDescriptors}
              onChange={(e) => update({ customStyleDescriptors: e.target.value })}
              placeholder="e.g. rounded corners everywhere, thick outlines, isometric product shots"
            />
            <p className="text-xs text-muted-foreground">
              {identity.customStyleDescriptors.length}/{MAX_CUSTOM_DESCRIPTORS}
            </p>
          </div>

          <div className="space-y-2">
            <Label>Rules</Label>
            <p className="text-xs text-muted-foreground">Appended to every prompt as &ldquo;Always: …&rdquo; and &ldquo;Never: …&rdquo;.</p>
            {identity.imageGenerationRules.map((rule, i) => (
              <div key={i} className="flex gap-2">
                <Select value={rule.kind} onValueChange={(v) => setRule(i, { kind: v as ImageRule["kind"] })}>
                  <SelectTrigger className="w-28">
                    <SelectValue>{rule.kind === "do" ? "Always" : "Never"}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="do">Always</SelectItem>
                    <SelectItem value="dont">Never</SelectItem>
                  </SelectContent>
                </Select>
                <Input value={rule.text} onChange={(e) => setRule(i, { text: e.target.value })} className="flex-1" placeholder="no hands" />
                <Button type="button" variant="ghost" size="sm" aria-label="Remove rule" onClick={() => removeRule(i)}>
                  <X className="size-4" />
                </Button>
              </div>
            ))}
            <div className="flex gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => addRule("do")}>
                <Plus /> Always…
              </Button>
              <Button type="button" variant="outline" size="sm" onClick={() => addRule("dont")}>
                <Plus /> Never…
              </Button>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-2">
              <Label>Background</Label>
              <Select value={identity.backgroundTreatment} onValueChange={(v) => update({ backgroundTreatment: v as VisualIdentity["backgroundTreatment"] })}>
                <SelectTrigger>
                  <SelectValue>{labelOf(BACKGROUND_TREATMENTS, identity.backgroundTreatment)}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {BACKGROUND_TREATMENTS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Texture</Label>
              <Select value={identity.texture} onValueChange={(v) => update({ texture: v as VisualIdentity["texture"] })}>
                <SelectTrigger>
                  <SelectValue>{labelOf(TEXTURES, identity.texture)}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {TEXTURES.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>People</Label>
              <Select value={identity.peopleStyle} onValueChange={(v) => update({ peopleStyle: v as VisualIdentity["peopleStyle"] })}>
                <SelectTrigger>
                  <SelectValue>{labelOf(PEOPLE_STYLES, identity.peopleStyle)}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {PEOPLE_STYLES.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <Label>
            <Switch checked={identity.pinStyleToCover} onCheckedChange={(v) => update({ pinStyleToCover: v })} />
            Use each post&apos;s cover as a style reference for its body images
          </Label>
        </div>
      )}

      <div className="flex justify-end">
        <Button type="button" variant="outline" disabled={!dirty || saving} onClick={save}>
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
    </div>
  );
}
