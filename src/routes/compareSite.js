import { Router }        from "express";
import path              from "path";
import fs                from "fs";
import { randomUUID }    from "crypto";
import { fileURLToPath } from "url";

import manifestSections                                     from "../services/siteService.js";
import { getBrowser }                                       from "../capture/browser.js";
import { captureConfig }                                    from "../capture/config.js";
import { captureEnv }                                       from "../services/captureService.js";
import {
  matchDatasetSections,
  diffSections,
  buildDiffStitchSections,
  calcAvgMismatch,
  toOutputUrl,
}                                                           from "../services/diffService.js";
import { pageStitcher }                                     from "../capture/pageStitcher.js";
import { createJob, getJob, updateJob, completeJob, failJob ,mapJob } from "../services/jobStore.js";

const __dirname   = path.dirname(fileURLToPath(import.meta.url));
const OUTPUTS_DIR = path.resolve(__dirname, "..", "outputs");

const router = Router();

// ─────────────────────────────────────────────────────────────────────────────
// Progress thresholds
//
//   0 %  → Initialising          (job created, manifest loading)
//  10 %  → Launching Browser     (browser boot)
//  20 %  → Capturing Live        (live screenshots in flight)
//  40 %  → Capturing Staging     (staging screenshots in flight)
//  60 %  → Comparing             (pixel diff)
//  80 %  → Building Report       (stitching diff images)
// 100 %  → Done                  (completeJob)
// ─────────────────────────────────────────────────────────────────────────────

// ── POST /compare-site ────────────────────────────────────────────────────────
// Starts the job asynchronously and immediately returns { runId }.
// ─────────────────────────────────────────────────────────────────────────────
router.post("/compare-site", (req, res) => {
  const {
    siteName,
    liveBaseUrl,
    stagingBaseUrl,
    pages,
    selectedDisplayResolution,
  } = req.body;

  if (!siteName || !liveBaseUrl || !stagingBaseUrl || !pages?.length) {
    return res.status(400).json({
      message: "siteName, liveBaseUrl, stagingBaseUrl and pages[] are required",
    });
  }

  const runId = randomUUID();
  createJob(runId);

  // Fire-and-forget — the route returns before this finishes
  runComparison({
    runId,
    siteName,
    liveBaseUrl,
    stagingBaseUrl,
    pages,
    selectedDisplayResolution,
  }).catch((err) => {
    // Belt-and-suspenders: runComparison already calls failJob internally,
    // but catch unhandled edge-cases here too.
    console.error(`[compare-site] Unhandled top-level error for run ${runId}:`, err);
    failJob(runId, err.message ?? "Unknown error");
  });

  return res.status(202).json({ runId });
});



// ── GET /compare-site/:runId/status ──────────────────────────────────────────
// Polled by the frontend every N ms while the job is running.
// ─────────────────────────────────────────────────────────────────────────────
router.get("/compare-site/:runId/status", (req, res) => {
  const job = getJob(req.params.runId);
  if (!job) return res.status(404).json({ message: "Job not found" });

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  // Race guard: job may already be finished when client connects
  if (job.status === "done")  { send({ status: "done",  result: job.result }); return res.end(); }
  if (job.status === "error") { send({ status: "error", error:  job.error  }); return res.end(); }
  send({ status: "running", phase: job.phase, progress: job.progress });

  const unMap = mapJob(req.params.runId, (updated) => {
    if (updated.status === "done") {
      send({ status: "done", result: updated.result });
      unMap(); res.end();
    } else if (updated.status === "error") {
      send({ status: "error", error: updated.error });
      unMap(); res.end();
    } else {
      send({ status: "running", phase: updated.phase, progress: updated.progress });
    }
  });

  req.on("close", unMap);
});

// router.get("/compare-site/:runId/status", (req, res) => {
//   const job = getJob(req.params.runId);

//   if (!job) {
//     return res.status(404).json({ message: "Job not found" });
//   }

//   // Always return the full snapshot; result is null until done.
//   return res.json({
//     runId:    job.runId,
//     status:   job.status,
//     phase:    job.phase,
//     progress: job.progress,
//     result:   job.result,   // populated only when status === "done"
//     error:    job.error,    // populated only when status === "error"
//   });
// });

// ─────────────────────────────────────────────────────────────────────────────
// runComparison — the actual async worker
// ─────────────────────────────────────────────────────────────────────────────
async function runComparison({
  runId,
  siteName,
  liveBaseUrl,
  stagingBaseUrl,
  pages,
  selectedDisplayResolution,
}) {
  let browser;

  try {
    // ── 0 % — Initialising ────────────────────────────────────────────────
    updateJob(runId, { status: "running", phase: "Initialising", progress: 0 });

    const captureRunConfig = {
      ...captureConfig,
      viewport:
        selectedDisplayResolution === "mobile"
          ? { width: 412,  height: 924  }
          : { width: 1440, height: 978  },
    };

    const { live: liveManifest, staging: stagingManifest } =
      await manifestSections(siteName, pages, liveBaseUrl, stagingBaseUrl);

    // ── 10 % — Launching browser ─────────────────────────────────────────
    updateJob(runId, { phase: "Launching browser", progress: 10 });
    browser = await getBrowser();

    // Unique output folder for this run
    const runDir = path.join(OUTPUTS_DIR, runId);
    fs.mkdirSync(runDir, { recursive: true });

    const now     = new Date();
    const runDate = now.toISOString().split("T")[0];
    const runTime = now.toTimeString().split(" ")[0];

    // Per-page progress band: live 20–39 %, staging 40–59 %, diff 60–79 %,
    // stitch 80–99 %. We divide each band evenly across pages.
    const pageCount    = pages.length;
    const bandPerPage  = pageCount > 0 ? 1 / pageCount : 1;

    const allPageResults = [];

    for (let pi = 0; pi < pages.length; pi++) {
      const pageName     = pages[pi];
      const livePageDef  = liveManifest[pageName];
      const stagingPageDef = stagingManifest[pageName];

      if (!livePageDef || !stagingPageDef) {
        console.warn(`[compare-site] Page "${pageName}" not found in manifest, skipping.`);
        continue;
      }

      const pageDir = path.join(runDir, pageName);
      fs.mkdirSync(pageDir, { recursive: true });

      const pageOffset = pi * bandPerPage; // fraction through this page (0–1)

      // ── ~20 % — Capturing live ─────────────────────────────────────────
      updateJob(runId, {
        phase:    `Capturing live${pageCount > 1 ? ` (${pageName})` : ""}`,
        progress: Math.round(20 + pageOffset * 20),
      });
      console.log(`[compare-site] Capturing live: ${pageName}`);
      const liveResult = await captureEnv(
        browser,
        livePageDef,
        path.join(pageDir, "live.png"),
        captureRunConfig,
      );

      // ── ~40 % — Capturing staging ──────────────────────────────────────
      updateJob(runId, {
        phase:    `Capturing staging${pageCount > 1 ? ` (${pageName})` : ""}`,
        progress: Math.round(40 + pageOffset * 20),
      });
      console.log(`[compare-site] Capturing staging: ${pageName}`);
      const stagingResult = await captureEnv(
        browser,
        stagingPageDef,
        path.join(pageDir, "staging.png"),
        captureRunConfig,
      );

      // ── ~60 % — Comparing ──────────────────────────────────────────────
      updateJob(runId, {
        phase:    `Comparing${pageCount > 1 ? ` (${pageName})` : ""}`,
        progress: Math.round(60 + pageOffset * 20),
      });
      const matches = matchDatasetSections(
        liveResult.capturedSections,
        stagingResult.capturedSections,
        livePageDef.sections,
      );
      const { diffSectionMap, sectionMismatchPcts } = await diffSections(matches);

      // ── ~80 % — Building report ────────────────────────────────────────
      updateJob(runId, {
        phase:    `Building report${pageCount > 1 ? ` (${pageName})` : ""}`,
        progress: Math.round(80 + pageOffset * 20),
      });
      const orderedStitchSections = buildDiffStitchSections(
        liveResult.resolvedSections,
        matches,
      );
      const diffPath = path.join(pageDir, "diff.png");
      await pageStitcher(orderedStitchSections, diffSectionMap, diffPath);

      const avgMismatchPct = calcAvgMismatch(sectionMismatchPcts);

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

    // ── 100 % — Done ──────────────────────────────────────────────────────
    completeJob(runId, { runId, runDate, runTime, results: allPageResults });

  } catch (err) {
    console.error(`[compare-site] Error in run ${runId}:`, err);
    failJob(runId, err.message ?? "Unknown error");
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

export default router;
