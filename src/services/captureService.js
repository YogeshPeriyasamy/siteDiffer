import path from "path";

import { getBrowser } from "../capture/browser.js";
import { captureConfig } from "../capture/config.js";
import { cleanUp, showHidden } from "../capture/cleanUp.js";
import { stabilizePage } from "../stabilize/index.js";
import { resolveGeometry, measurePage } from "../capture/screenshot.js";
import { captureSections } from "../capture/sectionCapturer.js";
import { pageStitcher, normalizeSectionLayout } from "../capture/pageStitcher.js";

// ---------------------------------------------------------------------------
// captureEnv
//
// Opens a new browser context, navigates to pageDef.url, stabilises the page,
// resolves section geometry, captures all sections, and stitches them into
// a single PNG at outPath.
//
// Returns { capturedSections, resolvedSections, stitched }
// ---------------------------------------------------------------------------
export async function captureEnv(browser, pageDef, outPath, config = captureConfig) {
  const context = await browser.newContext({
    viewport: config.viewport,
    deviceScaleFactor: config.deviceScaleFactor,
  });
  const accordianSelector = pageDef.accordianSelector || null;

  try {
    const page = await context.newPage();

    console.log(`[captureEnv] Navigating to: ${pageDef.url}`);

    await page.goto(pageDef.url, {
      waitUntil: config.waitUntil,
      timeout: config.timeout,
    });

    await cleanUp(page);
    // console.log(`[captureEnv] Page has accordianSelector: ${accordianSelector} ${pageDef.accordianSelector}`);
    await showHidden(accordianSelector, page);
    await stabilizePage(page);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(300);

    const resolvedSections = await resolveGeometry(page, pageDef);

    // Log any sections that resolved with zero geometry (selector not found)
    const zeroGeo = resolvedSections.filter((s) => !s.width || !s.height);
    if (zeroGeo.length > 0) {
      console.warn(`[captureEnv] ${zeroGeo.length} section(s) with zero geometry on ${pageDef.url}:`);
      zeroGeo.forEach((s) => console.warn(`  → key="${s.key}" selector="${s.selector}" width=${s.width} height=${s.height}`));
    }

    const extraction = {
      url: pageDef.url,
      scrollRootSelector: pageDef.scrollRootSelector,
      scrollRootIsWindow: pageDef.scrollRootIsWindow,
      page: await measurePage(page, pageDef.scrollRootSelector, pageDef.scrollRootIsWindow),
      sections: resolvedSections,
    };

    const capturedSections = await captureSections(page, extraction, config);
    const orderedSections = normalizeSectionLayout(resolvedSections);
    const stitched = await pageStitcher(orderedSections, capturedSections, outPath);

    return { capturedSections, resolvedSections, stitched };
  } finally {
    await context.close();
  }
}
