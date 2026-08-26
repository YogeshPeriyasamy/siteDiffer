import { Router } from "express";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";
import { fileURLToPath } from "url";

import manifestSections from "../services/siteService.js";
import { getBrowser } from "../capture/browser.js";
import { captureConfig } from "../capture/config.js";
import { captureEnv } from "../services/captureService.js";
import { matchDatasetSections, diffSections, buildDiffStitchSections, calcAvgMismatch, toOutputUrl } from "../services/diffService.js";
import { pageStitcher } from "../capture/pageStitcher.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUTS_DIR = path.resolve(__dirname, "..", "outputs");

const router = Router();

// ---------------------------------------------------------------------------
// POST /compare-site
//
// Body (JSON):
//   {
//     siteName:       string,   – resolved site key (from /pages response)
//     liveBaseUrl:    string,   – e.g. "https://elzonris.com"
//     stagingBaseUrl: string,   – e.g. "https://elzonris_v1.teststl.com"
//     pages:          string[], – page IDs to compare
//   }
//
// Response 200:
//   { runId, runDate, runTime, results: PageResult[] }
// ---------------------------------------------------------------------------
router.post("/compare-site", async (req, res) => {
  let browser;

  try {
    const { siteName, liveBaseUrl, stagingBaseUrl, pages, selectedDisplayResolution } = req.body;
    // console.log(`selected display : ${selectedDisplayResolution}`);

    const captureRunConfig = {
      ...captureConfig,
      viewport:
        selectedDisplayResolution === "desktop"
          ? {
              width: 1440,
              height: 978,
            }
          : {
              width: 412,
              height: 924,
            },
    };

    if (!siteName || !liveBaseUrl || !stagingBaseUrl || !pages?.length) {
      return res.status(400).json({
        message: "siteName, liveBaseUrl, stagingBaseUrl and pages[] are required",
      });
    }

    const { live: liveManifest, staging: stagingManifest } = await manifestSections(siteName, pages, liveBaseUrl, stagingBaseUrl);

    browser = await getBrowser();

    // Unique folder for this run
    const runId = randomUUID();
    const runDir = path.join(OUTPUTS_DIR, runId);
    fs.mkdirSync(runDir, { recursive: true });

    // Run timestamp
    const now = new Date();
    const runDate = now.toISOString().split("T")[0]; // YYYY-MM-DD
    const runTime = now.toTimeString().split(" ")[0]; // HH:MM:SS

    const allPageResults = [];

    for (const pageName of pages) {
      const livePageDef = liveManifest[pageName];
      const stagingPageDef = stagingManifest[pageName];

      if (!livePageDef || !stagingPageDef) {
        console.warn(`[compare-site] Page "${pageName}" not found in manifest, skipping.`);
        continue;
      }

      const pageDir = path.join(runDir, pageName);
      fs.mkdirSync(pageDir, { recursive: true });

      console.log(`[compare-site] Capturing page: ${pageName}`);

      // ── Capture live + staging in parallel ─────────────────────────────
      const [liveResult, stagingResult] = await Promise.all([
        captureEnv(browser, livePageDef, path.join(pageDir, "live.png"), captureRunConfig),
        captureEnv(browser, stagingPageDef, path.join(pageDir, "staging.png"), captureRunConfig),
      ]);

      // ── Match, diff, and build diff section map ─────────────────────────
      const matches = matchDatasetSections(liveResult.capturedSections, stagingResult.capturedSections, livePageDef.sections);

      const { diffSectionMap, sectionMismatchPcts } = await diffSections(matches);

      // ── Stitch diff image ───────────────────────────────────────────────
      const orderedStitchSections = buildDiffStitchSections(liveResult.resolvedSections, matches);
      const diffPath = path.join(pageDir, "diff.png");
      await pageStitcher(orderedStitchSections, diffSectionMap, diffPath);

      const avgMismatchPct = calcAvgMismatch(sectionMismatchPcts);

      allPageResults.push({
        page: pageName,
        livePageUrl: livePageDef.url,
        stagingPageUrl: stagingPageDef.url,
        liveUrl: toOutputUrl(path.join(runId, pageName, "live.png")),
        stagingUrl: toOutputUrl(path.join(runId, pageName, "staging.png")),
        diffUrl: toOutputUrl(path.join(runId, pageName, "diff.png")),
        avgMismatchPct,
        sectionCount: {
          defined: livePageDef.sections.length,
          captured: Object.keys(diffSectionMap).length,
          matched: matches.filter((m) => m.kind === "matched").length,
          missingInStaging: matches.filter((m) => m.kind === "live-only").length,
          missingInLive: matches.filter((m) => m.kind === "staging-only").length,
        },
      });
    }

    return res.json({ runId, runDate, runTime, results: allPageResults });
  } catch (error) {
    console.error("[compare-site] Error:", error);
    return res.status(500).json({ message: "Error processing site comparison", error: error.message });
  } finally {
    if (browser) await browser.close();
  }
});

export default router;
