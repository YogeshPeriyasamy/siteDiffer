import "dotenv/config";
import express from "express";
import cors from "cors";
import multer from "multer";
import path from "path";
import fs from "fs";
import sharp from "sharp";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";

import { getBrowser } from "./capture/browser/browser.js";
import { capturePageToDir, resolveGeometry, measurePage } from "./capture/capture/screenshot.js";
import { captureSections } from "./capture/capture/dom/sectionCapturer.js";
import { pageStitcher, normalizeSectionLayout } from "./capture/capture/dom/pageStitcher.js";
import { compareImages } from "./core/index.js";
import { captureConfig } from "./capture/config/playwrightConfig.js";
import { stabilizePage } from "./capture/stabilize/src/index.js";
import { cleanUp } from "./capture/capture/scenarios/cleanUp.js";
import manifestSections, {
  resolveSiteKeyFromHostname,
  getPagesForSite,
} from "./capture/capture/dom/manifestSections.js";

const __dirname   = path.dirname(fileURLToPath(import.meta.url));
const OUTPUTS_DIR = path.resolve(__dirname, "outputs");
const UPLOADS_DIR = path.resolve(__dirname, "uploads");

if (!fs.existsSync(OUTPUTS_DIR)) fs.mkdirSync(OUTPUTS_DIR, { recursive: true });
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const application = express();
const uploads     = multer({ dest: UPLOADS_DIR });

// CORS — restrict to origins listed in ALLOWED_ORIGINS env var
const rawOrigins = process.env.ALLOWED_ORIGINS ?? "";
const allowedOrigins = rawOrigins
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

application.use(
  cors({
    origin: allowedOrigins.length === 1 && allowedOrigins[0] === "*"
      ? "*"
      : (origin, callback) => {
          // Allow requests with no origin (e.g. server-to-server, curl)
          if (!origin) return callback(null, true);
          if (allowedOrigins.includes(origin)) return callback(null, true);
          callback(new Error(`CORS: origin "${origin}" is not allowed`));
        },
  }),
);
application.use("/outputs", express.static(OUTPUTS_DIR));

// ---------------------------------------------------------------------------
// GET /pages
//
// Accepts ?liveUrl=...&stagingUrl=... (query params).
// Resolves the site from the live hostname, validates that staging matches the
// same site entry, and returns the list of available pages.
//
// Response 200:
//   { siteKey: string, pages: [{ id, label, path }] }
//
// Response 400:
//   { message: string }
// ---------------------------------------------------------------------------
application.get("/pages", (req, res) => {
  const { liveUrl, stagingUrl } = req.query;

  if (!liveUrl || !stagingUrl) {
    return res.status(400).json({ message: "liveUrl and stagingUrl are required" });
  }

  let liveHost, stagingHost;
  try {
    liveHost    = new URL(liveUrl).hostname.replace(/^www\./, "");
    stagingHost = new URL(stagingUrl).hostname.replace(/^www\./, "");
  } catch {
    return res.status(400).json({ message: "Invalid URL format" });
  }

  const liveSiteKey    = resolveSiteKeyFromHostname(liveHost);
  const stagingSiteKey = resolveSiteKeyFromHostname(stagingHost);

  if (!liveSiteKey) {
    return res.status(400).json({
      message: `No site configuration found for "${liveHost}". Check the live URL.`,
    });
  }

  if (!stagingSiteKey) {
    return res.status(400).json({
      message: `No site configuration found for "${stagingHost}". Check the staging URL.`,
    });
  }

  if (liveSiteKey !== stagingSiteKey) {
    return res.status(400).json({
      message: `URLs appear to be for different sites ("${liveSiteKey}" vs "${stagingSiteKey}"). Both URLs must belong to the same site.`,
    });
  }

  const pages = getPagesForSite(liveSiteKey);
  return res.json({ siteKey: liveSiteKey, pages });
});

// ---------------------------------------------------------------------------
// POST /compare-site
//
// Body (JSON):
//   {
//     siteName:       string,     – resolved site key (from /pages response)
//     liveBaseUrl:    string,     – e.g. "https://elzonris.com"
//     stagingBaseUrl: string,     – e.g. "https://elzonris_v1.teststl.com"
//     pages:          string[],   – page IDs to compare
//   }
//
// Response 200:
//   {
//     runId:    string,
//     runDate:  string,   – ISO date string
//     runTime:  string,   – HH:MM:SS (local time of server)
//     results:  PageResult[]
//   }
//
// PageResult:
//   {
//     page:           string,
//     livePageUrl:    string,
//     stagingPageUrl: string,
//     liveUrl:        string,   – relative path to live.png  (for /outputs serving)
//     stagingUrl:     string,   – relative path to staging.png
//     diffUrl:        string,   – relative path to diff.png
//     avgMismatchPct: number,   – average mismatch % across all sections (0–100)
//     sectionCount: { defined, captured, matched, missingInStaging, missingInLive }
//   }
// ---------------------------------------------------------------------------
application.post("/compare-site", express.json(), async (req, res) => {
  let browser;

  try {
    const { siteName, liveBaseUrl, stagingBaseUrl, pages } = req.body;

    if (!siteName || !liveBaseUrl || !stagingBaseUrl || !pages?.length) {
      return res.status(400).json({
        message: "siteName, liveBaseUrl, stagingBaseUrl and pages[] are required",
      });
    }

    const { live: liveManifest, staging: stagingManifest } =
      await manifestSections(siteName, pages, liveBaseUrl, stagingBaseUrl);

    browser = await getBrowser();

    // Unique folder for this run
    const runId  = randomUUID();
    const runDir = path.join(OUTPUTS_DIR, runId);
    fs.mkdirSync(runDir, { recursive: true });

    // Run timestamp
    const now     = new Date();
    const runDate = now.toISOString().split("T")[0];                         // YYYY-MM-DD
    const runTime = now.toTimeString().split(" ")[0];                        // HH:MM:SS

    const allPageResults = [];

    for (const pageName of pages) {
      const livePageDef    = liveManifest[pageName];
      const stagingPageDef = stagingManifest[pageName];

      if (!livePageDef || !stagingPageDef) {
        console.warn(`[compare-site] Page "${pageName}" not found in dataset, skipping.`);
        continue;
      }

      const pageDir = path.join(runDir, pageName);
      fs.mkdirSync(pageDir, { recursive: true });

      console.log(`[compare-site] Capturing page: ${pageName}`);

      // ── Capture live + staging in parallel ──────────────────────────────
      const [liveResult, stagingResult] = await Promise.all([
        captureEnv(browser, livePageDef,    path.join(pageDir, "live.png")),
        captureEnv(browser, stagingPageDef, path.join(pageDir, "staging.png")),
      ]);

      // ── Diff sections ────────────────────────────────────────────────────
      const matches = matchDatasetSections(
        liveResult.capturedSections,
        stagingResult.capturedSections,
        livePageDef.sections,
      );

      const diffSectionMap = {};
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

      // ── Stitch diff image ────────────────────────────────────────────────
      const stitchSections = [...liveResult.resolvedSections];
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

      const orderedStitchSections = normalizeSectionLayout(stitchSections);
      const diffPath = path.join(pageDir, "diff.png");
      await pageStitcher(orderedStitchSections, diffSectionMap, diffPath);

      // ── Average mismatch % across all diffed sections ────────────────────
      const avgMismatchPct = sectionMismatchPcts.length > 0
        ? parseFloat(
            (sectionMismatchPcts.reduce((a, b) => a + b, 0) / sectionMismatchPcts.length).toFixed(2),
          )
        : 0;

      allPageResults.push({
        page:           pageName,
        livePageUrl:    livePageDef.url,
        stagingPageUrl: stagingPageDef.url,
        liveUrl:        toOutputUrl(path.join(runId, pageName, "live.png")),
        stagingUrl:     toOutputUrl(path.join(runId, pageName, "staging.png")),
        diffUrl:        toOutputUrl(path.join(runId, pageName, "diff.png")),
        avgMismatchPct,
        sectionCount: {
          defined:          livePageDef.sections.length,
          captured:         Object.keys(diffSectionMap).length,
          matched:          matches.filter((m) => m.kind === "matched").length,
          missingInStaging: matches.filter((m) => m.kind === "live-only").length,
          missingInLive:    matches.filter((m) => m.kind === "staging-only").length,
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

// ---------------------------------------------------------------------------
// POST /compare  (direct image upload diff — unchanged except buffer unwrap)
// ---------------------------------------------------------------------------
application.post("/compare", uploads.fields([{ name: "liveImage" }, { name: "stagedImage" }]), async (req, res) => {
  try {
    const liveImagePath   = req.files?.["liveImage"]?.[0]?.path;
    const stagedImagePath = req.files?.["stagedImage"]?.[0]?.path;
    if (!liveImagePath || !stagedImagePath) {
      return res.status(400).json({ message: "liveImage and stagedImage are required" });
    }
    const { buffer } = await compareImages(liveImagePath, stagedImagePath);
    res.set("Content-Type", "image/png");
    return res.send(buffer);
  } catch (error) {
    console.error("Error processing images:", error);
    return res.status(500).json({ message: "Error processing images", error: error.message });
  }
});

// ---------------------------------------------------------------------------
// Server bootstrap
// ---------------------------------------------------------------------------
const PORT = parseInt(process.env.PORT ?? "4000", 10);
const server = application.listen(PORT, () => console.log(`Server running on port ${PORT}`));

server.on("error",              (err)    => console.error("Server error:", err));
process.on("uncaughtException", (err)    => console.error("Uncaught exception:", err));
process.on("unhandledRejection",(reason) => console.error("Unhandled rejection:", reason));
process.stdin.resume();

// ---------------------------------------------------------------------------
// captureEnv
// ---------------------------------------------------------------------------
async function captureEnv(browser, pageDef, outPath) {
  const context = await browser.newContext({
    viewport:          captureConfig.viewport,
    deviceScaleFactor: captureConfig.deviceScaleFactor,
  });

  try {
    const page = await context.newPage();

    console.log(`[captureEnv] Navigating to: ${pageDef.url}`);

    await page.goto(pageDef.url, {
      waitUntil: captureConfig.waitUntil,
      timeout:   captureConfig.timeout,
    });

    await cleanUp(page);
    await stabilizePage(page);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(300);

    const resolvedSections = await resolveGeometry(page, pageDef);

    // Log resolved geometry so we can detect zero-dimension failures
    const zeroGeo = resolvedSections.filter((s) => !s.width || !s.height);
    if (zeroGeo.length > 0) {
      console.warn(`[captureEnv] ${zeroGeo.length} section(s) resolved with zero geometry on ${pageDef.url}:`);
      zeroGeo.forEach((s) => console.warn(`  → key="${s.key}" selector="${s.selector}" width=${s.width} height=${s.height}`));
    }

    const extraction = {
      url:                pageDef.url,
      scrollRootSelector: pageDef.scrollRootSelector,
      scrollRootIsWindow: pageDef.scrollRootIsWindow,
      page:               await measurePage(page,pageDef.scrollRootSelector,pageDef.scrollRootIsWindow),
      sections:           resolvedSections,
    };

    const capturedSections  = await captureSections(page, extraction, captureConfig);
    const orderedSections   = normalizeSectionLayout(resolvedSections);
    const stitched          = await pageStitcher(orderedSections, capturedSections, outPath);

    return { capturedSections, resolvedSections, stitched };
  } finally {
    await context.close();
  }
}

// ---------------------------------------------------------------------------
// Section matching helpers
// ---------------------------------------------------------------------------
function matchDatasetSections(liveSections, stagingSections, datasetSectionDefs) {
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
      matches.push({
        kind: "matched",
        liveKey,
        stagingKey: best.stagingKey,
        liveSection,
        stagingSection: best.stagingSection,
        score: +bestScore.toFixed(3),
      });
    } else {
      matches.push({ kind: "live-only", liveKey, stagingKey: null, liveSection, stagingSection: null, score: 0 });
    }
  }

  for (const [stagingKey, stagingSection] of stagingEntries) {
    if (usedStagingKeys.has(stagingKey)) continue;
    matches.push({ kind: "staging-only", liveKey: null, stagingKey, liveSection: null, stagingSection, score: 0 });
  }

  return matches;
}

function buildDatasetNameLookup(defs) {
  const map = new Map();
  for (const { section: name, state = [] } of defs ?? []) {
    if (!state?.length) { map.set(name, name); }
    else state.forEach((_, i) => map.set(`${name}State${i}`, name));
  }
  return map;
}

// Inline placeholder — identical to what was there before; referenced by matchDatasetSections
function datasetSectionMatchScore(liveKey, liveSection, stagingKey, stagingSection, datasetNameFor) {
  const liveName    = datasetNameFor.get(liveKey)    ?? liveKey;
  const stagingName = datasetNameFor.get(stagingKey) ?? stagingKey;
  if (liveName === stagingName) return 1;
  if (liveName.toLowerCase() === stagingName.toLowerCase()) return 0.9;
  return 0;
}

/**
 * Creates a white PNG canvas of the given dimensions using sharp.
 * Used when one environment is missing a section — the white canvas is then
 * compared against the real section screenshot to produce a diff that shows
 * the entire section as "changed", and is stitched into the diff image.
 */
async function missingSectionBuffer(width, height) {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  return sharp({
    create: {
      width:      w,
      height:     h,
      channels:   4,
      background: { r: 255, g: 255, b: 255, alpha: 255 },
    },
  })
    .png()
    .toBuffer();
}

function toOutputUrl(relPath) {
  return `/outputs/${relPath.replace(/\\/g, "/")}`;
}
