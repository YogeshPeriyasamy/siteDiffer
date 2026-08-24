import sharp from "sharp";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STITCHED_DIR = path.resolve(__dirname, "..", "stitchedImages");

export function normalizeSectionLayout(sections) {
  const ordered = [...(sections ?? [])]
    .filter(Boolean)
    .sort((a, b) => (a.y ?? 0) - (b.y ?? 0) || (a.x ?? 0) - (b.x ?? 0));

  let cursorY = 0;
  return ordered.map((section) => {
    const nextY = cursorY;
    cursorY += section.height || 0;
    return {
      ...section,
      y: nextY,
    };
  });
}

export async function pageStitcher(sections, sectionMap, outputPath) {
  if (!fs.existsSync(STITCHED_DIR)) fs.mkdirSync(STITCHED_DIR, { recursive: true });

  const orderedSections = normalizeSectionLayout(sections);

  if (!outputPath) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    outputPath = path.join(STITCHED_DIR, `stitched_${timestamp}.png`);
  }

  const normalSections = orderedSections.filter((s) => !s.floating);
  const floatingSections = orderedSections.filter((s) => s.floating);

  // ── Pass 1 — compute adjustedY for every section ───────────────────────────
  //
  // Sort by original Y so we walk top-to-bottom.
  // Every scrollable section that expanded pushes everything below it down
  // by its expansion amount.  Expansions are cumulative.
  //
  //   Example (3 sections, section B is scrollable and expands by 800px):
  //
  //   Section A  originalY=0    expansion=0    cumulativeShift=0  → adjustedY=0
  //   Section B  originalY=300  expansion=800  cumulativeShift=0  → adjustedY=300
  //                                            cumulativeShift becomes 800
  //   Section C  originalY=700  expansion=0    cumulativeShift=800 → adjustedY=1500
  //
  // Result: A at 0, B at 300 (1200px tall), C at 1500 — no overlap, no gap.

  // const sorted = [...sections].sort((a, b) => a.y - b.y || a.x - b.x);
  const sorted = [...normalSections].sort((a, b) => a.y - b.y || a.x - b.x);

  let cumulativeShift = 0;
  let lastExpandedY = -1; // original Y of the last section that caused a shift
  const adjusted = []; // { section, captured, adjustedY, adjustedH, useFullBuffer }

  for (const section of sorted) {
    const captured = sectionMap[section.key];

    if (!captured) {
      console.warn(`  ⚠️  No map entry for section: ${section.key} — skipping`);
      continue;
    }

    const expansion = captured.expansion ?? 0;
    const useFullBuffer = expansion > 0 && captured.fullBuffer != null;

    const adjustedY = section.y + cumulativeShift;
    const adjustedH = useFullBuffer
      ? section.height + expansion // full scroll content height
      : section.height; // normal / overflow-hidden

    adjusted.push({
      section,
      captured,
      adjustedY,
      adjustedH,
      useFullBuffer,
    });

    console.log(
      `[stitch] ${section.key}` +
        ` originalY=${section.y}` +
        ` shift=${cumulativeShift}` +
        ` adjustedY=${adjustedY}` +
        ` adjustedH=${adjustedH}` +
        (useFullBuffer ? " [fullBuffer]" : ""),
    );

    // only shift once per Y band — siblings at the same original Y share the
    // same expansion row so we must not double-count it.
    // e.g. section B (y=300, expansion=800) and section B2 (y=300, expansion=800)
    // are side-by-side columns; only the first one seen increments the shift.
    if (expansion > 0 && section.y !== lastExpandedY) {
      cumulativeShift += expansion;
      lastExpandedY = section.y;
    }
  }

  // ── compute canvas dimensions ──────────────────────────────────────────────
  let canvasW = 0;
  let canvasH = 0;

  for (const { section, adjustedY, adjustedH } of adjusted) {
    canvasW = Math.max(canvasW, section.x + section.width);
    canvasH = Math.max(canvasH, adjustedY + adjustedH);
  }

  console.log(`[stitch] canvas ${canvasW}w × ${canvasH}h`);

  // ── Pass 2 — composite all sections onto the canvas ───────────────────────
  const composites = [];
  let stitchedCount = 0;
  let floatingCount = 0;
  let skippedCount = 0;
  let placeholderCount = 0;

  for (const { section, captured, adjustedY, adjustedH, useFullBuffer } of adjusted) {
    if (!captured.buffer) {
      console.warn(`  ⚠️  Missing buffer for: ${section.key} — skipping`);
      skippedCount++;
      continue;
    }

    if (captured.error) {
      console.warn(`  ⚠️  Section ${section.key} had capture error: ${captured.error} — using placeholder`);
      placeholderCount++;
    }

    // choose the right buffer
    let inputBuffer = useFullBuffer ? captured.fullBuffer : captured.buffer;

    // verify dimensions match what we expect, resize if somehow off
    const meta = await sharp(inputBuffer).metadata();
    const expectedW = section.width;
    const expectedH = adjustedH;

    if (meta.width !== expectedW || meta.height !== expectedH) {
      console.log(`  [resize] ${section.key} ${meta.width}x${meta.height} → ${expectedW}x${expectedH}`);
      // Guard: skip sections with zero target dimensions — they indicate a
      // failed geometry resolution (selector not found in the DOM).
      if (expectedW < 1 || expectedH < 1) {
        console.warn(`  ⚠️  Skipping ${section.key} — target dimensions are ${expectedW}×${expectedH} (selector may not exist on this page)`);
        skippedCount++;
        continue;
      }
      inputBuffer = await sharp(inputBuffer).resize(expectedW, expectedH, { fit: "fill" }).png().toBuffer();
    }

    composites.push({
      input: inputBuffer,
      left: section.x,
      top: adjustedY,
    });

    stitchedCount++;
  }

  let floatingTop = canvasH + (floatingSections.length > 0 ? 32 : 0);
  for (const section of floatingSections) {
    const captured = sectionMap[section.key];
    if (!captured?.buffer || captured.error) {
      skippedCount++;
      continue;
    }

    const inputBuffer = captured.fullBuffer ?? captured.buffer;
    const meta = await sharp(inputBuffer).metadata();
    const left = Math.max(0, Math.round(section.x || 0));

    composites.push({
      input: inputBuffer,
      left,
      top: floatingTop,
    });

    canvasW = Math.max(canvasW, left + meta.width);
    floatingTop += meta.height + 24;
    floatingCount++;
    console.log(`[stitch:floating] ${section.key} ${meta.width}x${meta.height}`);
  }

  if (floatingCount > 0) {
    canvasH = floatingTop;
  }

  if (composites.length === 0) {
    throw new Error("No sections could be composited — nothing to stitch. All selectors may have failed to resolve on this page.");
  }

  // Guard against zero canvas which causes sharp to throw
  if (canvasW < 1 || canvasH < 1) {
    throw new Error(`Canvas dimensions are invalid (${canvasW}×${canvasH}). All sections resolved to zero geometry — check that selectors exist on the target page.`);
  }

  // ── create the final canvas and composite ─────────────────────────────────
  // console.log(`[stitch] compositing ${stitchedCount} sections...`);

  const stitchedImage = sharp({
    create: {
      width: canvasW,
      height: canvasH,
      channels: 3,
      background: "#f5f5f5",
    },
  })
    .composite(composites)
    .png();

  await stitchedImage.toFile(outputPath);
  console.log(`✅ Stitched saved → ${outputPath}`);

  const buffer = await sharp(outputPath).png().toBuffer();

  console.log(
    `✅ Stitched ${canvasW}w × ${canvasH}h | sections: ${stitchedCount} stitched, ${floatingCount} floating, ${skippedCount} skipped, ${placeholderCount} placeholders`,
  );

  return {
    success: true,
    path: outputPath,
    buffer,
    width: canvasW,
    height: canvasH,
    sectionCount: stitchedCount,
    floatingCount,
    skippedCount,
    placeholderCount,
  };
}
