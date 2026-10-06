import sharp from "sharp";
import path from "path";
import fs from "fs";

import { compareImages } from "../core/index.js";
import manifestSections from "../services/siteService.js";
import { stabilizePage } from "../stabilize/index.js";
import { cleanUp } from "../capture/cleanUp.js";
import { getBrowser } from "../capture/browser.js";
import { captureConfig } from "../capture/config.js";
import { captureEnv } from "../services/captureService.js";
import { matchDatasetSections, diffSections, buildDiffStitchSections, calcAvgMismatch, toOutputUrl } from "../services/diffService.js";
import { pageStitcher, normalizeSectionLayout } from "../capture/pageStitcher.js";
import { buildDOMTree, extractSectionsFromDOMTree } from "../services/sectionMapper.js";
import { resolveGeometry } from "../capture/screenshot.js";
import { captureSections } from "../capture/sectionCapturer.js";
import { measurePage } from "../utils/measurePage.js";
import { showAccordions } from "./revealHidden.js";
import { captureFullPage } from "../capture/goFullPage.js";
import { updateJob, completeJob, failJob, deleteJob } from "./jobStore.js";

export async function runComparison({ runId, selectedDisplayResolution, pages, threshold, OUTPUTS_DIR, isFullpageCapture }) {
  let browser;
  let runDir;
  let completed = false;

  try {
    // ── 0 % — Initialising ────────────────────────────────────────────────
    updateJob(runId, { status: "running", phase: "Initialising", progress: 0 });
    browser = await getBrowser();

    const captureRunConfig = {
      ...captureConfig,
      viewport: selectedDisplayResolution === "mobile" ? { width: 412, height: 924 } : { width: 1440, height: 978 },
    };

    //Unique output folder for this run
    runDir = path.join(OUTPUTS_DIR, runId);
    fs.mkdirSync(runDir, { recursive: true });

    const now = new Date();
    const runDate = now.toISOString().split("T")[0];
    const runTime = now.toTimeString().split(" ")[0];

    // Per-page progress
    const pageCount = pages.length;
    const bandPerPage = pageCount > 0 ? 1 / pageCount : 1;

    const results = [];

    // ── 5 % — Launching browser ─────────────────────────────────────────
    updateJob(runId, { phase: "Launching browsers", progress: 5 });
    const liveContext = await browser.newContext({
      viewport: captureRunConfig.viewport,
      deviceScaleFactor: captureRunConfig.deviceScaleFactor,
    });

    const stagingContext = await browser.newContext({
      viewport: captureRunConfig.viewport,
      deviceScaleFactor: captureRunConfig.deviceScaleFactor,
    });
    try {
      for (let pi = 0; pi < pages.length; pi++) {
        let livePage;
        let stagingPage;

        try {
          // ── 10 % — launch page and stabilize it ─────────────────────────────────────────
          updateJob(runId, { phase: "Launching site1 and stabilizing", progress: 10 });

          livePage = await liveContext.newPage();
          await livePage.goto(pages[pi].live, { waitUntil: captureRunConfig.waitUntil, timeout: captureRunConfig.timeout });
          await stabilizePage(livePage);
          await cleanUp(livePage);
          await livePage.evaluate(() => window.scrollTo(0, 0));
          await livePage.waitForTimeout(300);

          // ── 20 % — launch page and stabilize it ─────────────────────────────────────────
          updateJob(runId, { phase: "Launching site2 and stabilizing", progress: 20 });
          stagingPage = await stagingContext.newPage();
          await stagingPage.goto(pages[pi].staging, { waitUntil: captureRunConfig.waitUntil, timeout: captureRunConfig.timeout });
          await stabilizePage(stagingPage);
          await cleanUp(stagingPage);
          await stagingPage.evaluate(() => window.scrollTo(0, 0));
          await stagingPage.waitForTimeout(300);

          const pageDir = path.join(runDir, pages[pi].label);
          fs.mkdirSync(pageDir, { recursive: true });

          if (isFullpageCapture) {
            const pageOffset = pi * bandPerPage;
            updateJob(runId, {
              phase: `Capturing live${pageCount > 1 ? ` (${pages[pi].label})` : ""}`,
              progress: Math.round(40 + pageOffset * 10),
            });
            const livePageBuffer = await captureFullPage(livePage, captureRunConfig);

            updateJob(runId, {
              phase: `Capturing staging${pageCount > 1 ? ` (${pages[pi].label})` : ""}`,
              progress: Math.round(55 + pageOffset * 10),
            });
            const stagingPageBuffer = await captureFullPage(stagingPage, captureRunConfig);

            const livePngBuffer = await sharp(livePageBuffer).png().toBuffer();
            const stagingPngBuffer = await sharp(stagingPageBuffer).png().toBuffer();
            await Promise.all([
              fs.promises.writeFile(path.join(pageDir, "live.png"), livePngBuffer),
              fs.promises.writeFile(path.join(pageDir, "staging.png"), stagingPngBuffer),
            ]);

            updateJob(runId, {
              phase: `Comparing${pageCount > 1 ? ` (${pages[pi].label})` : ""}`,
              progress: Math.round(75 + pageOffset * 10),
            });
            const { buffer: rawDiffBuffer, mismatchPct } = await compareImages(livePngBuffer, stagingPngBuffer, {
              threshold,
            });
            const diffBuffer = await sharp(rawDiffBuffer).png().toBuffer();
            await fs.promises.writeFile(path.join(pageDir, "diff.png"), diffBuffer);

            results.push({
              page: pages[pi].label,
              livePageUrl: pages[pi].live,
              stagingPageUrl: pages[pi].staging,
              liveUrl: toOutputUrl(path.join(runId, pages[pi].label, "live.png")),
              stagingUrl: toOutputUrl(path.join(runId, pages[pi].label, "staging.png")),
              diffUrl: toOutputUrl(path.join(runId, pages[pi].label, "diff.png")),
              avgMismatchPct: mismatchPct,
              sectionCount: {
                defined: 1,
                captured: 1,
                matched: 1,
                missingInStaging: 0,
                missingInLive: 0,
              },
            });

            continue;
          }

          // ── 30 % — Extracting sections ─────────────────────────────────────────
          updateJob(runId, { phase: "Extracting Sections", progress: 30 });
          // Step 1: extract the full DOM hierarchy for both environments
          const [liveTree, stagingTree] = await Promise.all([
            buildDOMTree(livePage, captureRunConfig),
            buildDOMTree(stagingPage, captureRunConfig),
          ]);

          // return { live: liveTree, staging: stagingTree };
          const pageConfig = extractSectionsFromDOMTree(
            liveTree,
            stagingTree,
            pages[pi].label,
            pages[pi].path,
            pages[pi].live,
            pages[pi].staging,
          );
          console.log("pageConfig", pageConfig.live.sections, pageConfig.staging.sections);
          // return pageConfig;

          // create a unique key using section name
          pageConfig.live.sections = pageConfig.live.sections.map((s, i) => ({
            ...s,
            key: `${s.section.replace(/\s+/g, "_")}__${s.selector.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 10)}`,
          }));
          pageConfig.staging.sections = pageConfig.staging.sections.map((s, i) => ({
            ...s,
            key: `${s.section.replace(/\s+/g, "_")}__${s.selector.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 10)}`,
          }));

          const livePageDef = {
            url: pageConfig.live.liveURL,
            scrollRootSelector: pageConfig.live.scrollRoot,
            scrollRootIsWindow: pageConfig.live.scrollIsWindow,
            sections: pageConfig.live.sections,
          };
          const stagingPageDef = {
            url: pageConfig.staging.stagingURL,
            scrollRootSelector: pageConfig.staging.scrollRoot,
            scrollRootIsWindow: pageConfig.staging.scrollIsWindow,
            sections: pageConfig.staging.sections,
          };

          //to reveal all the accordions
          const liveOpenendAccordions = await showAccordions(livePage);
          const stagingOpenendAccordions = await showAccordions(stagingPage);
          console.log("accordions", liveOpenendAccordions, stagingOpenendAccordions);

          const liveResolvedSections = await resolveGeometry(livePage, livePageDef);
          const stagingResolvedSections = await resolveGeometry(stagingPage, stagingPageDef);

          // ── 40 % — Capturing live ─────────────────────────────────────────
          const pageOffset = pi * bandPerPage;
          updateJob(runId, {
            phase: `Capturing live${pageCount > 1 ? ` (${pages[pi].label})` : ""}`,
            progress: Math.round(40 + pageOffset * 10),
          });

          const liveExtraction = {
            url: pages[pi].live,
            scrollRootSelector: livePageDef.scrollRootSelector,
            scrollRootIsWindow: livePageDef.scrollRootIsWindow,
            page: await measurePage(livePage, livePageDef.scrollRootSelector, livePageDef.scrollRootIsWindow),
            sections: liveResolvedSections,
          };
          const liveCapturedSections = await captureSections(livePage, liveExtraction, captureRunConfig);

          // ── 55 % — Capturing staging ──────────────────────────────────────
          updateJob(runId, {
            phase: `Capturing staging${pageCount > 1 ? ` (${pages[pi].label})` : ""}`,
            progress: Math.round(55 + pageOffset * 10),
          });
          const stagingExtraction = {
            url: pages[pi].staging,
            scrollRootSelector: stagingPageDef.scrollRootSelector,
            scrollRootIsWindow: stagingPageDef.scrollRootIsWindow,
            page: await measurePage(stagingPage, stagingPageDef.scrollRootSelector, stagingPageDef.scrollRootIsWindow),
            sections: stagingResolvedSections,
          };
          const stagingCapturedSections = await captureSections(stagingPage, stagingExtraction, captureRunConfig);

          // ── 65 % — Stitching live & staging ──────────────────────────────
          updateJob(runId, {
            phase: `Stitching${pageCount > 1 ? ` (${pages[pi].label})` : ""}`,
            progress: Math.round(65 + pageOffset * 10),
          });
          const liveOrdered = normalizeSectionLayout(liveResolvedSections);
          const stagingOrdered = normalizeSectionLayout(stagingResolvedSections);
          await pageStitcher(liveOrdered, liveCapturedSections, path.join(pageDir, "live.png"));
          await pageStitcher(stagingOrdered, stagingCapturedSections, path.join(pageDir, "staging.png"));

          // ── 75 % — Comparing ──────────────────────────────────────────────
          updateJob(runId, {
            phase: `Comparing${pageCount > 1 ? ` (${pages[pi].label})` : ""}`,
            progress: Math.round(75 + pageOffset * 10),
          });
          const matches = matchDatasetSections(liveCapturedSections, stagingCapturedSections, livePageDef.sections);
          const { diffSectionMap, sectionMismatchData } = await diffSections(matches, threshold);

          // ── 85 % — Building report ────────────────────────────────────────
          updateJob(runId, {
            phase: `Building report${pageCount > 1 ? ` (${pages[pi].label})` : ""}`,
            progress: Math.round(85 + pageOffset * 10),
          });
          const orderedStitchSections = buildDiffStitchSections(liveResolvedSections, matches);
          const diffPath = path.join(pageDir, "diff.png");
          await pageStitcher(orderedStitchSections, diffSectionMap, diffPath);

          const avgMismatchPct = calcAvgMismatch(sectionMismatchData);

          results.push({
            page: pages[pi].label,
            livePageUrl: pages[pi].live,
            stagingPageUrl: pages[pi].staging,
            liveUrl: toOutputUrl(path.join(runId, pages[pi].label, "live.png")),
            stagingUrl: toOutputUrl(path.join(runId, pages[pi].label, "staging.png")),
            diffUrl: toOutputUrl(path.join(runId, pages[pi].label, "diff.png")),
            avgMismatchPct,
            sectionCount: {
              defined: livePageDef.sections.length,
              captured: Object.keys(diffSectionMap).length,
              matched: matches.filter((m) => m.kind === "matched").length,
              missingInStaging: matches.filter((m) => m.kind === "live-only").length,
              missingInLive: matches.filter((m) => m.kind === "staging-only").length,
            },
          });
        } catch (err) {
          throw err;
        } finally {
          if (livePage) await livePage.close();
          if (stagingPage) await stagingPage.close();
        }
      }
    } finally {
      await liveContext.close();
      await stagingContext.close();
    }

    // ── 100 % — Done ──────────────────────────────────────────────────────
    completeJob(runId, { runId, runDate, runTime, results });
    completed = true;
  } catch (error) {
    console.error(`[compare-site] Error in run ${runId}:`, error);
    failJob(runId, error.message ?? "Unknown error");
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (!completed && runId) deleteJob(runId);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// runComparison — the actual async worker
// ─────────────────────────────────────────────────────────────────────────────

// async function runComparison({ runId, siteName, liveBaseUrl, stagingBaseUrl, pages, selectedDisplayResolution }) {
//   let browser;
//   let runDir;
//   let completed = false;

//   try {
//     // ── 0 % — Initialising ────────────────────────────────────────────────
//     updateJob(runId, { status: "running", phase: "Initialising", progress: 0 });

//     const captureRunConfig = {
//       ...captureConfig,
//       viewport: selectedDisplayResolution === "mobile" ? { width: 412, height: 924 } : { width: 1440, height: 978 },
//     };

//     const { live: liveManifest, staging: stagingManifest } = await manifestSections(siteName, pages, liveBaseUrl, stagingBaseUrl);

//     // ── 10 % — Launching browser ─────────────────────────────────────────
//     updateJob(runId, { phase: "Launching browser", progress: 10 });
//     browser = await getBrowser();

//     // Unique output folder for this run
//     runDir = path.join(OUTPUTS_DIR, runId);
//     fs.mkdirSync(runDir, { recursive: true });

//     const now = new Date();
//     const runDate = now.toISOString().split("T")[0];
//     const runTime = now.toTimeString().split(" ")[0];

//     // Per-page progress band: live 20–49 %, staging 50–79 %, visual Diff and generate report 80–100 %,
//     const pageCount = pages.length;
//     const bandPerPage = pageCount > 0 ? 1 / pageCount : 1;

//     const allPageResults = [];

//     for (let pi = 0; pi < pages.length; pi++) {
//       const pageName = pages[pi];
//       const livePageDef = liveManifest[pageName];
//       const stagingPageDef = stagingManifest[pageName];

//       if (!livePageDef || !stagingPageDef) {
//         console.warn(`[compare-site] Page "${pageName}" not found in manifest, skipping.`);
//         continue;
//       }

//       const pageDir = path.join(runDir, pageName);
//       fs.mkdirSync(pageDir, { recursive: true });

//       const pageOffset = pi * bandPerPage; // fraction through this page (0–1)

//       // ── ~20 % — Capturing live ─────────────────────────────────────────
//       updateJob(runId, {
//         phase: `Capturing live${pageCount > 1 ? ` (${pageName})` : ""}`,
//         progress: Math.round(20 + pageOffset * 20),
//       });
//       console.log(`[compare-site] Capturing live: ${pageName}`);
//       const liveResult = await captureEnv(browser, livePageDef, path.join(pageDir, "live.png"), captureRunConfig);

//       // ── ~60 % — Capturing staging ──────────────────────────────────────
//       updateJob(runId, {
//         phase: `Capturing staging${pageCount > 1 ? ` (${pageName})` : ""}`,
//         progress: Math.round(50 + pageOffset * 20),
//       });
//       console.log(`[compare-site] Capturing staging: ${pageName}`);
//       const stagingResult = await captureEnv(browser, stagingPageDef, path.join(pageDir, "staging.png"), captureRunConfig);

//       // ── ~80 % — Comparing ──────────────────────────────────────────────
//       updateJob(runId, {
//         phase: `Comparing${pageCount > 1 ? ` (${pageName})` : ""}`,
//         progress: Math.round(80 + pageOffset * 20),
//       });
//       const matches = matchDatasetSections(liveResult.capturedSections, stagingResult.capturedSections, livePageDef.sections);
//       const { diffSectionMap, sectionMismatchPcts } = await diffSections(matches);

//       // ── ~90 % — Building report ────────────────────────────────────────
//       updateJob(runId, {
//         phase: `Building report${pageCount > 1 ? ` (${pageName})` : ""}`,
//         progress: Math.round(90 + pageOffset * 20),
//       });
//       const orderedStitchSections = buildDiffStitchSections(liveResult.resolvedSections, matches);
//       const diffPath = path.join(pageDir, "diff.png");
//       await pageStitcher(orderedStitchSections, diffSectionMap, diffPath);

//       const avgMismatchPct = calcAvgMismatch(sectionMismatchPcts);

//       allPageResults.push({
//         page: pageName,
//         livePageUrl: livePageDef.url,
//         stagingPageUrl: stagingPageDef.url,
//         liveUrl: toOutputUrl(path.join(runId, pageName, "live.png")),
//         stagingUrl: toOutputUrl(path.join(runId, pageName, "staging.png")),
//         diffUrl: toOutputUrl(path.join(runId, pageName, "diff.png")),
//         avgMismatchPct,
//         sectionCount: {
//           defined: livePageDef.sections.length,
//           captured: Object.keys(diffSectionMap).length,
//           matched: matches.filter((m) => m.kind === "matched").length,
//           missingInStaging: matches.filter((m) => m.kind === "live-only").length,
//           missingInLive: matches.filter((m) => m.kind === "staging-only").length,
//         },
//       });
//     }

//     // ── 100 % — Done ──────────────────────────────────────────────────────
//     completeJob(runId, { runId, runDate, runTime, results: allPageResults });
//     completed = true;//the comparison has been completed
//   } catch (err) {
//     console.error(`[compare-site] Error in run ${runId}:`, err);
//     failJob(runId, err.message ?? "Unknown error");
//   } finally {
//     if (browser) await browser.close().catch(() => {});
//     if (!completed && runId) deleteJob(runId); //delete the current run incase of failures
//   }
// }
