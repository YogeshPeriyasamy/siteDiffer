import { writeToFile } from "../utils/fileWriter.js";

export function computeDiff(liveImage, stagedImage, width, height, options = {}) {
  const { threshold, ignoreAA } = options;

  // console.log("Computing perceptual diff with AA detection...", { width, height, threshold, ignoreAA });

  const diffData = new Uint8Array(width * height);
  let count = 0;
  const MAX_PERCEPTUAL_DIFF = 765;

  // First pass: Calculate perceptual difference for all pixels
  for (let i = 0; i < liveImage.length; i += 4) {
    const pixelIndex = i / 4;

    // Get RGBA values
    const r1 = liveImage[i];
    const g1 = liveImage[i + 1];
    const b1 = liveImage[i + 2];
    const a1 = liveImage[i + 3];

    const r2 = stagedImage[i];
    const g2 = stagedImage[i + 1];
    const b2 = stagedImage[i + 2];
    const a2 = stagedImage[i + 3];

    // Calculate perceptual color difference
    const diff = perceptualColorDifference(r1, g1, b1, a1, r2, g2, b2, a2);
    const normalizedDiff = Math.min(diff / MAX_PERCEPTUAL_DIFF, 1);

    // Mark as changed if above threshold
    if (normalizedDiff > threshold) {
      diffData[pixelIndex] = 1;
      count++;
    }
  }

  // Second pass: Anti-aliasing detection
  if (!ignoreAA) {
    count = detectAndRemoveAntiAliasing(diffData, liveImage, stagedImage, width, height);
  }

  // console.log(`Total mismatched pixels: ${count}`);
  return { data: diffData, width, height, diffCount: count };
}

/**
 * Perceptual color difference using luminance-weighted formula
 * More accurate than simple RGB sum
 */
function perceptualColorDifference(r1, g1, b1, a1, r2, g2, b2, a2) {
  // Ignore if alpha significantly different (transparency change)
  const alphaDiff = Math.abs(a1 - a2);
  if (alphaDiff > 128) return 255; // Treat as major change

  // Normalize to 0-1
  const c1 = [r1 / 255, g1 / 255, b1 / 255];
  const c2 = [r2 / 255, g2 / 255, b2 / 255];

  // Calculate mean red for weighted formula
  const rMean = (c1[0] + c2[0]) / 2;

  // Deltas
  const dR = c1[0] - c2[0];
  const dG = c1[1] - c2[1];
  const dB = c1[2] - c2[2];

  // Luminance-weighted formula (human eye more sensitive to green)
  // Based on perceived brightness differences
  const redWeight = 2 + rMean;
  const greenWeight = 4;
  const blueWeight = 3 - rMean;

  const weightedDiff = redWeight * dR * dR + greenWeight * dG * dG + blueWeight * dB * dB;
  return Math.sqrt(weightedDiff) * 255;
}

/**
 * Anti-aliasing detection: Remove isolated changed pixels at edges
 * If a pixel appears different but is surrounded by original colors,
 * it's likely anti-aliasing artifact
 */
function detectAndRemoveAntiAliasing(diffData, liveImage, stagedImage, width, height) {
  const aaPixels = new Set();

  // Check each changed pixel
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const pixelIndex = y * width + x;

      if (diffData[pixelIndex] === 0) continue; // Skip unchanged pixels

      // Check if this is likely an AA pixel
      if (isAntiAliasPixel(x, y, width, height, liveImage, stagedImage)) {
        aaPixels.add(pixelIndex);
      }
    }
  }

  // Remove AA pixels from diff
  let count = 0;
  for (let i = 0; i < diffData.length; i++) {
    if (!aaPixels.has(i) && diffData[i] === 1) {
      count++;
    } else if (aaPixels.has(i)) {
      diffData[i] = 0;
    }
  }

  // console.log(`Detected and removed ${aaPixels.size} anti-aliasing pixels`);
  return count;
}

/**
 * Check if a pixel is likely anti-aliasing artifact
 * AA pixels are usually semi-transparent or intermediate colors at edges
 */
function isAntiAliasPixel(x, y, width, height, liveImage, stagedImage) {
  const pixelIndex = y * width + x;
  const pixelByteIndex = pixelIndex * 4;

  const liveAlpha = liveImage[pixelByteIndex + 3];
  const stagedAlpha = stagedImage[pixelByteIndex + 3];

  // If alpha < 200, likely semi-transparent (AA characteristic)
  if (liveAlpha < 200 || stagedAlpha < 200) {
    return hasStrongSurroundingPixels(x, y, width, height, liveImage, stagedImage);
  }

  return false;
}

/**
 * Check if pixel is surrounded by strong (unchanged) pixels
 * AA pixels typically exist on edges of shapes
 */
function hasStrongSurroundingPixels(x, y, width, height, liveImage, stagedImage) {
  const neighbors = [
    [x - 1, y - 1],
    [x, y - 1],
    [x + 1, y - 1],
    [x - 1, y],
    [x + 1, y],
    [x - 1, y + 1],
    [x, y + 1],
    [x + 1, y + 1],
  ];

  let matchingNeighbors = 0;

  for (const [nx, ny] of neighbors) {
    if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;

    const neighborIndex = (ny * width + nx) * 4;

    // Check if neighbor is similar in both images (unchanged)
    const rDiff = Math.abs(liveImage[neighborIndex] - stagedImage[neighborIndex]);
    const gDiff = Math.abs(liveImage[neighborIndex + 1] - stagedImage[neighborIndex + 1]);
    const bDiff = Math.abs(liveImage[neighborIndex + 2] - stagedImage[neighborIndex + 2]);

    if (rDiff < 30 && gDiff < 30 && bDiff < 30) {
      matchingNeighbors++;
    }
  }

  // If 6+ neighbors are unchanged, this pixel is likely AA on an edge
  return matchingNeighbors >= 6;
}
