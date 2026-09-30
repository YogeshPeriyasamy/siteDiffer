import { preprocessImage } from "./processing/preprocess.js";
import { computeDiff } from "./compare/computeDiff.js";
import { denoise } from "./processing/denoise.js";
import { findRegions, mergeRegions, expandRegion } from "./processing/cluster.js";
import { renderWithHighlight } from "./render/createHighlight.js";
import { encoder } from "./render/imageEncode.js";

// ---------------------------------------------------------------------------
// compareImages
//
// Compares two images (buffers or file paths) and returns:
//   {
//     buffer:       Buffer  – the highlighted diff PNG
//     mismatchPct:  number  – 0–100, percentage of pixels that differ
//   }
// ---------------------------------------------------------------------------

export async function compareImages(liveInput, stagedInput, options = {}) {
  const { threshold = 0.3, ignoreAA = false } = options;

  // console.log("Comparing images...", { threshold, ignoreAA });
  try {
    const { width, height, liveImage, stagedImage } = await preprocessImage(liveInput, stagedInput);

    // Perceptual diff with optional AA detection
    const diff = await computeDiff(liveImage, stagedImage, width, height, {
      threshold,
      ignoreAA,
    });

    // Remove noise
    const denoisedDiff = await denoise(diff.data, width, height);

    // Cluster differing pixels into regions
    let regions = await findRegions(denoisedDiff, width, height);
    regions = mergeRegions(regions);
    regions = regions.map((r) => expandRegion(r, width, height));

    // covered diff pixels
    const coveredPixels = regions.reduce((sum, r) => sum + (r.maxX - r.minX) * (r.maxY - r.minY), 0);

    // Render highlighted diff on top of staged image
    const highlightedImage = await renderWithHighlight(stagedImage, regions, width, height, denoisedDiff);

    // Encode to PNG
    const buffer = await encoder(highlightedImage, width, height);

    // ── Mismatch percentage ──────────────────────────────────────────────
    // coveredPixels = sum of expanded region bounding-box areas.
    // mismatchPct   = fraction of THIS section's canvas that is highlighted.
    // width/height are returned so callers can do a pixel-weighted page average.
    const totalPixels = width * height;
    const mismatchPct = totalPixels > 0 ? parseFloat(((coveredPixels / totalPixels) * 100).toFixed(4)) : 0;

    return { buffer, mismatchPct, coveredPixels, width, height };
  } catch (error) {
    console.error("Error comparing images:", error);
    throw error;
  }
}
