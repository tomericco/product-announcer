import { describe, it, expect, vi } from "vitest";
import sharp from "sharp";
import crypto from "node:crypto";
import { MAX_DELIVERABLE_BYTES, MAX_IMAGE_BYTES, compressPng, imageDimensions } from "../../../src/lib/images/compress";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

async function solidPng(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 4, background: { r: 200, g: 30, b: 30, alpha: 1 } } })
    .png()
    .toBuffer();
}

/** Deterministic pseudo-noise: the worst case for PNG, and what a photo upload looks like. */
async function noisyJpeg(width: number, height: number): Promise<Buffer> {
  const pixels = Buffer.alloc(width * height * 3);
  for (let i = 0; i < pixels.length; i++) pixels[i] = (i * 2654435761) % 256;
  return sharp(pixels, { raw: { width, height, channels: 3 } }).jpeg({ quality: 90 }).toBuffer();
}

/**
 * True random RGB bytes, encoded straight to PNG (no JPEG pass in between).
 * Verified by hand: the `noisyJpeg` LCG pattern above is compressible enough
 * (through JPEG quantization, then PNG palette-mode) that EVERY brief-specified
 * "large/unreachable" test case is satisfied by the very first encode attempt
 * (256-colour palette, full width) — the width step-down loop never runs for
 * any input in this file. Cryptographically random pixels defeat PNG's Paeth
 * predictor and palette quantization enough to force actual width reduction,
 * which is the only way to exercise (and aspect-guard) the second half of the
 * bounded loop in compress.ts.
 */
async function trueRandomPng(width: number, height: number): Promise<Buffer> {
  const raw = crypto.randomBytes(width * height * 3);
  return sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

describe("compressPng", () => {
  it("resizes down to maxWidth keeping aspect and returns a PNG", async () => {
    const input = await solidPng(2400, 1260);
    const out = await compressPng(input, 1200);
    expect(out.width).toBe(1200);
    expect(out.height).toBe(630);
    expect(out.png.subarray(0, 4).equals(PNG_SIGNATURE)).toBe(true);
    const meta = await sharp(out.png).metadata();
    expect(meta.width).toBe(1200);
    expect(meta.format).toBe("png");
  });

  it("never enlarges a smaller image", async () => {
    const input = await solidPng(600, 300);
    const out = await compressPng(input, 1200);
    expect(out.width).toBe(600);
    expect(out.height).toBe(300);
  });

  it("does not grow a flat graphic", async () => {
    const input = await solidPng(1200, 630);
    const out = await compressPng(input, 1200);
    expect(out.png.byteLength).toBeLessThanOrEqual(input.byteLength);
  });

  it("keeps a realistic flat cover far under the 1 MB ceiling (and so under Webflow's 4 MB / LinkedIn's 5 MB)", async () => {
    // The cover master the agent produces: 1200 px wide, flat fills. This is
    // the claim spec §8 makes ("guaranteed by the compression pass"); pin it so
    // a future change to the sharp options can't quietly break Webflow
    // rehosting.
    const out = await compressPng(await solidPng(2400, 1260), 1200);
    expect(out.png.byteLength).toBeLessThan(MAX_IMAGE_BYTES);
    expect(MAX_IMAGE_BYTES).toBe(1_000_000);
    expect(MAX_DELIVERABLE_BYTES).toBe(4 * 1024 * 1024);
  });

  it("accepts a JPEG input and emits a PNG (the upload path, spec §5 uploads)", async () => {
    const out = await compressPng(await noisyJpeg(1600, 900), 1200);
    expect(out.png.subarray(0, 4).equals(PNG_SIGNATURE)).toBe(true);
    expect(out.width).toBeLessThanOrEqual(1200);
    expect(await sharp(out.png).metadata().then((m) => m.format)).toBe("png");
  });

  it("NEVER changes the aspect ratio — a square render stays square", async () => {
    // The no-crop guarantee (product owner decision 1). Providers sometimes
    // round a 1200x624 request to a square supported size; `renderImage` asks
    // again once (Task 9) and, if the answer is still square, we store it
    // square rather than cut pixels the concept asked for. Plan 4 publishes
    // exactly these numbers as coverImage.width/height.
    const out = await compressPng(await solidPng(1024, 1024), 1200);
    expect({ width: out.width, height: out.height }).toEqual({ width: 1024, height: 1024 });
  });

  it("brings a large noisy image under 1 MB with the aspect ratio intact", async () => {
    // A photograph upload — the worst case for PNG and the reason the ceiling
    // exists at all (a quantised 1200 px photo can otherwise exceed 4 MB and
    // Webflow 400s at publish with a message the user cannot act on).
    const input = await noisyJpeg(3000, 2000);
    const out = await compressPng(input, 1200);
    expect(out.png.byteLength).toBeLessThanOrEqual(MAX_IMAGE_BYTES);
    // 3:2 in, 3:2 out — the ceiling is met by width + palette, never by crop.
    expect(Math.abs(out.width / out.height - 3 / 2)).toBeLessThan(0.02);
    const meta = await sharp(out.png).metadata();
    expect({ width: meta.width, height: meta.height }).toEqual({ width: out.width, height: out.height });
  },
    // Generating a 3000x2000 noise JPEG and compressing it does not fit
    // vitest's 5s default — it came in at 5,006ms under the parallel suite,
    // failing on a margin of six milliseconds. Every other heavy case in this
    // file already carries an explicit ceiling; this one was relying on the
    // default and had simply not crossed it yet.
    30_000
  );

  it("leaves an already-small image essentially alone — no needless quality loss", async () => {
    // The common case must not pay for the ceiling: a 600x300 flat graphic is
    // already well under 1 MB, so the first encode returns and no step-down
    // loop runs.
    const input = await solidPng(600, 300);
    const out = await compressPng(input, 1200);
    expect({ width: out.width, height: out.height }).toEqual({ width: 600, height: 300 });
    expect(out.png.byteLength).toBeLessThanOrEqual(MAX_IMAGE_BYTES);
  });

  it(
    "returns the smallest result it achieved rather than throwing when the ceiling is unreachable",
    async () => {
      // Bounded attempts: if even the last width step is over the ceiling we
      // return that result and log — a slightly-over image beats a failed draft.
      // Forced by asking for a ceiling-busting width on noise: maxWidth is
      // honoured downward, so this exercises the same loop with a tiny budget.
      const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const input = await noisyJpeg(4000, 3000);
      const out = await compressPng(input, 4000);
      expect(Buffer.isBuffer(out.png)).toBe(true);
      expect(out.width).toBeGreaterThan(0);
      // Either it got under the ceiling, or it warned and returned its best.
      if (out.png.byteLength > MAX_IMAGE_BYTES) expect(consoleWarn).toHaveBeenCalled();
      consoleWarn.mockRestore();
    },
    // Generating a 4000x3000 noise buffer in JS plus repeated palette/width
    // sharp passes comfortably exceeds vitest's 5s default; the compression
    // itself is fast (~2.5s), the noise fixture is the slow part (~3.2s).
    15_000
  );

  it(
    "genuinely exercises the width step-down loop — not just palette quantization — and still keeps the aspect ratio exact",
    async () => {
      // None of the brief's noisyJpeg-based cases actually reach the width
      // loop: measured by hand, a 4000x3000 LCG-noise JPEG already lands
      // under MAX_IMAGE_BYTES at the very first attempt (256-colour palette,
      // full width). That leaves the second half of the bounded loop in
      // compress.ts — the part that could silently start cropping or
      // distorting height — completely untested by this suite. True random
      // pixels defeat palette quantization (measured: 2400x1600 stays over
      // MAX_IMAGE_BYTES through all three palette steps) and force real
      // width reduction before the ceiling is met.
      const width = 2400;
      const height = 1600;
      const input = await trueRandomPng(width, height);
      const out = await compressPng(input, width);

      expect(out.png.byteLength).toBeLessThanOrEqual(MAX_IMAGE_BYTES);
      // The width loop actually ran (proves this case exercises what the
      // brief's other "large noise" tests do not).
      expect(out.width).toBeLessThan(width);
      // The guarantee under test: width-only resize inside the loop must
      // reproduce the source ratio exactly via integer rounding, not drift
      // toward a crop or a distorted height.
      expect(out.height).toBe(Math.round((out.width * height) / width));
      const meta = await sharp(out.png).metadata();
      expect({ width: meta.width, height: meta.height }).toEqual({ width: out.width, height: out.height });
    },
    // Multiple full-resolution sharp encodes (palette steps + width steps) on
    // 2400x1600 of true random pixel data. Measured at ~10.5s on the machine
    // this was written on, which made 30s look like a 3x margin. On a busier
    // machine it runs ~27s alone and times out under the parallel suite — it
    // failed intermittently for a while and then consistently, always at
    // ~30.0s, which reads as a real breakage rather than the boundary case it
    // is. The work is genuinely this heavy, so the ceiling moves rather than
    // the test shrinking: a bound exists to catch a runaway, not to assert a
    // speed nobody measured.
    90_000
  );

  it("rejects bytes that are not an image, so an upload of a renamed file fails before Blob", async () => {
    // `uploadImageFile` (Plan 3) trusts the browser-supplied mime type; this
    // throw is what actually stops non-image bytes reaching Vercel Blob.
    await expect(compressPng(Buffer.from("not an image at all"), 1200)).rejects.toThrow();
  });
});

describe("imageDimensions", () => {
  it("reads the real pixel dimensions (what the cover aspect guard measures)", async () => {
    expect(await imageDimensions(await solidPng(1200, 630))).toEqual({ width: 1200, height: 630 });
  });

  it("throws on bytes sharp cannot parse — callers decide what that means", async () => {
    await expect(imageDimensions(Buffer.from("nope"))).rejects.toThrow();
  });
});
