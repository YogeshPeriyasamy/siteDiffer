import sharp from "sharp";

/**
 * Ensures buffer is exactly targetW × targetH.
 *
 * Width  too large  → crop right edge
 * Width  too small  → extend right edge with neutral background
 * Height too large  → crop bottom  (visible slot is what matters for stitching)
 * Height too small  → extend bottom with neutral background
 */
export async function normalizeToExactSize(buffer, targetW, targetH) {
  const meta = await sharp(buffer).metadata();
  if (meta.width === targetW && meta.height === targetH) return buffer;

  let img = sharp(buffer);

  // ── fix width ──────────────────────────────────────────────────────────────
  if (meta.width > targetW) {
    img = img.extract({ left: 0, top: 0, width: targetW, height: meta.height });
  } else if (meta.width < targetW) {
    img = img.extend({
      right: targetW - meta.width,
      background: { r: 245, g: 245, b: 245, alpha: 255 },
    });
  }

  const afterW = await img.png().toBuffer();
  const afterWMeta = await sharp(afterW).metadata();

  // ── fix height ─────────────────────────────────────────────────────────────
  let img2 = sharp(afterW);

  if (afterWMeta.height > targetH) {
    // crop: keep only the top targetH rows (the visible page slot)
    img2 = img2.extract({ left: 0, top: 0, width: targetW, height: targetH });
  } else if (afterWMeta.height < targetH) {
    // extend: pad the bottom
    img2 = img2.extend({
      bottom: targetH - afterWMeta.height,
      background: { r: 245, g: 245, b: 245, alpha: 255 },
    });
  }

  return img2.png().toBuffer();
}

/**
 * Normalizes a single strip to width × height (used during strip stitching).
 */
export async function normalizeStrip(buffer, width, height) {
  const meta = await sharp(buffer).metadata();
  if (meta.width === width && meta.height === height) return buffer;
  return sharp(buffer).resize(width, height, { fit: "fill" }).png().toBuffer();
}
