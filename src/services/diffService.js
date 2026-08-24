import sharp from "sharp";

import { compareImages } from "../core/index.js";
import { normalizeSectionLayout, pageStitcher } from "../capture/pageStitcher.js";

// ---------------------------------------------------------------------------
// matchDatasetSections
//
// Aligns live section keys to staging section keys.
// Returns an array of match records:
//   { kind: "matched",      liveKey, stagingKey, liveSection, stagingSection }
//   { kind: "live-only",    liveKey, liveSection }
//   { kind: "staging-only", stagingKey, stagingSection }
// ---------------------------------------------------------------------------
export function matchDatasetSections(liveSections, stagingSections, datasetSectionDefs) {
  const stagingEntries  = Object.entries(stagingSections ?? {});
  const usedStagingKeys = new Set();
  const matches         = [];
  const datasetNameFor  = buildDatasetNameLookup(datasetSectionDefs);

  for (const [liveKey, liveSection] of Object.entries(liveSections ?? {})) {
    let best = null, bestScore = 0;

    for (const [stagingKey, stagingSection] of stagingEntries) {
      if (usedStagingKeys.has(stagingKey)) continue;
      const score = datasetSectionMatchScore(liveKey, liveSection, stagingKey, stagingSection, datasetNameFor);
      if (score > bestScore) { bestScore = score; best = { stagingKey, stagingSection }; }
    }

    if (best && bestScore >= 0.5) {
      usedStagingKeys.add(best.stagingKey);
      matches.push({ kind: "matched", liveKey, stagingKey: best.stagingKey, liveSection, stagingSection: best.stagingSection });
    } else {
      matches.push({ kind: "live-only", liveKey, liveSection });
    }
  }

  for (const [stagingKey, stagingSection] of stagingEntries) {
    if (!usedStagingKeys.has(stagingKey)) {
      matches.push({ kind: "staging-only", stagingKey, stagingSection });
    }
  }

  return matches;
}

// ---------------------------------------------------------------------------
// diffSections
//
// Iterates match records, calls compareImages on each pair (using a white
// placeholder for missing-side sections), and builds the diffSectionMap.
//
// Returns { diffSectionMap, sectionMismatchPcts }
// ---------------------------------------------------------------------------
export async function diffSections(matches) {
  const diffSectionMap      = {};
  const sectionMismatchPcts = [];

  for (const match of matches) {
    if (match.kind === "matched") {
      const { liveSection, stagingSection } = match;
      if (!liveSection?.buffer || !stagingSection?.buffer) continue;

      const { buffer: diffBuffer, mismatchPct } =
        await compareImages(liveSection.buffer, stagingSection.buffer);

      sectionMismatchPcts.push(mismatchPct);
      diffSectionMap[match.liveKey] = {
        ...liveSection,
        buffer:     diffBuffer,
        fullBuffer: liveSection.expansion > 0 ? diffBuffer : null,
        expansion:  liveSection.expansion || 0,
        error:      null,
      };
      continue;
    }

    if (match.kind === "live-only") {
      const { liveSection } = match;
      if (!liveSection?.buffer) continue;

      const { buffer: diffBuffer, mismatchPct } = await compareImages(
        liveSection.buffer,
        await missingSectionBuffer(liveSection.width, liveSection.height),
      );

      sectionMismatchPcts.push(mismatchPct);
      diffSectionMap[match.liveKey] = {
        ...liveSection,
        buffer:     diffBuffer,
        fullBuffer: liveSection.expansion > 0 ? diffBuffer : null,
        expansion:  liveSection.expansion || 0,
        error:      null,
      };
      continue;
    }

    if (match.kind === "staging-only") {
      const { stagingSection } = match;
      if (!stagingSection?.buffer) continue;

      const { buffer: diffBuffer, mismatchPct } = await compareImages(
        await missingSectionBuffer(stagingSection.width, stagingSection.height),
        stagingSection.buffer,
      );

      sectionMismatchPcts.push(mismatchPct);
      diffSectionMap[match.stagingKey] = {
        ...stagingSection,
        buffer:     diffBuffer,
        fullBuffer: stagingSection.expansion > 0 ? diffBuffer : null,
        expansion:  stagingSection.expansion || 0,
        error:      null,
      };
    }
  }

  return { diffSectionMap, sectionMismatchPcts };
}

// ---------------------------------------------------------------------------
// buildDiffStitchSections
//
// Augments the live resolvedSections list with synthetic entries for any
// staging-only sections (so the diff stitcher has something to place them at).
// ---------------------------------------------------------------------------
export function buildDiffStitchSections(liveResolvedSections, matches) {
  const stitchSections = [...liveResolvedSections];

  for (const match of matches) {
    if (match.kind !== "staging-only" || !match.stagingSection) continue;

    const { stagingSection } = match;
    const syntheticSection = {
      key:       match.stagingKey,
      selector:  stagingSection.selector || match.stagingKey,
      x:         stagingSection.x ?? 0,
      y:         stagingSection.y ?? 0,
      width:     stagingSection.width ?? 0,
      height:    stagingSection.height ?? 0,
      floating:  false,
      expansion: 0,
      discovery: "synthetic",
    };

    const insertIndex = stitchSections.findIndex(
      (s) => (s.y ?? 0) >= (syntheticSection.y ?? 0),
    );
    if (insertIndex >= 0) stitchSections.splice(insertIndex, 0, syntheticSection);
    else                  stitchSections.push(syntheticSection);
  }

  return normalizeSectionLayout(stitchSections);
}

// ---------------------------------------------------------------------------
// calcAvgMismatch
// ---------------------------------------------------------------------------
export function calcAvgMismatch(sectionMismatchPcts) {
  if (!sectionMismatchPcts.length) return 0;
  return parseFloat(
    (sectionMismatchPcts.reduce((a, b) => a + b, 0) / sectionMismatchPcts.length).toFixed(2),
  );
}

// ---------------------------------------------------------------------------
// toOutputUrl — converts an absolute output path to a relative /outputs URL
// ---------------------------------------------------------------------------
export function toOutputUrl(relPath) {
  return `/outputs/${relPath.replace(/\\/g, "/")}`;
}

// ---------------------------------------------------------------------------
// missingSectionBuffer — plain white placeholder PNG
// ---------------------------------------------------------------------------
export async function missingSectionBuffer(width, height) {
  return sharp({
    create: {
      width:    Math.max(1, Math.round(width  || 100)),
      height:   Math.max(1, Math.round(height || 100)),
      channels: 3,
      background: { r: 255, g: 255, b: 255 },
    },
  })
    .png()
    .toBuffer();
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------
function buildDatasetNameLookup(sectionDefs) {
  const map = {};
  for (const def of sectionDefs ?? []) {
    if (def.key) map[def.key] = def.key;
  }
  return map;
}

function datasetSectionMatchScore(liveKey, _liveSection, stagingKey, _stagingSection, datasetNameFor) {
  // Exact key match — highest confidence
  if (liveKey === stagingKey) return 1.0;
  // Case-insensitive match
  if (liveKey.toLowerCase() === stagingKey.toLowerCase()) return 0.9;
  // Both map to the same dataset name
  if (datasetNameFor[liveKey] && datasetNameFor[liveKey] === datasetNameFor[stagingKey]) return 0.8;
  return 0;
}
