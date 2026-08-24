import path from "path";
import { fileURLToPath } from "url";

import { captureConfig } from "./config.js";
import { cleanUp } from "./cleanUp.js";
import { stabilizePage } from "../stabilize/index.js";
import { captureSections } from "./sectionCapturer.js";
import { pageStitcher } from "./pageStitcher.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CRITICAL_SIGNALS = ["readyState"];

// ---------------------------------------------------------------------------
// capturePageToDir
//
// Navigates to a URL, stabilises the page, runs dataset-driven section capture
// using the resolved extraction descriptor, stitches the result, and writes the
// final PNG directly to `outPath`.
//
// Returns { capturedSections, stitched }
// ---------------------------------------------------------------------------
export async function capturePageToDir(browser, pageDef, resolvedSections, outPath) {
  const context = await browser.newContext({
    viewport: captureConfig.viewport,
    deviceScaleFactor: captureConfig.deviceScaleFactor,
  });

  try {
    const page = await context.newPage();

    await page.goto(pageDef.url, {
      waitUntil: captureConfig.waitUntil,
      timeout: captureConfig.timeout,
    });

    await cleanUp(page);

    const stabilizeLogs = await stabilizePage(page);
    const failedCritical = stabilizeLogs.logs
      .filter((s) => s.status === "failed" && CRITICAL_SIGNALS.includes(s.name))
      .map((s) => `${s.name}: ${s.error}`);

    if (failedCritical.length > 0) {
      throw new Error(`Page unstable: ${failedCritical.join(", ")}`);
    }

    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(100);

    const extraction = {
      url: pageDef.url,
      scrollRootSelector: pageDef.scrollRootSelector,
      scrollRootIsWindow: pageDef.scrollRootIsWindow,
      page: await measurePage(page, pageDef.scrollRootSelector, pageDef.scrollRootIsWindow),
      sections: resolvedSections,
    };

    const capturedSections = await captureSections(page, extraction, captureConfig);
    const stitched = await pageStitcher(resolvedSections, capturedSections, outPath);

    return { capturedSections, stitched };
  } finally {
    await context.close();
  }
}

// ---------------------------------------------------------------------------
// resolveGeometry
//
// For each dataset section descriptor, queries the live DOM for its bounding
// rect so sectionCapturer has real coordinates. State configs (e.g. scrollTo)
// are applied before measuring.
// ---------------------------------------------------------------------------
export async function resolveGeometry(page, pageDef) {
  const { scrollRootSelector, scrollRootIsWindow, sections } = pageDef;
  const resolved = [];

  for (const section of sections) {
    if (section.stateConfig) {
      await applyStateConfig(page, section.stateConfig, scrollRootSelector, scrollRootIsWindow);
      await page.waitForTimeout(300);
    }

    let geo = await page.evaluate(
      ({ selector, scrollRootSelector, scrollRootIsWindow }) => {
        const el = document.querySelector(selector);
        if (!el) return null;
        const rect = el.getBoundingClientRect();
        const scrollX = scrollRootIsWindow ? window.scrollX : (document.querySelector(scrollRootSelector)?.scrollLeft ?? 0);
        const scrollY = scrollRootIsWindow ? window.scrollY : (document.querySelector(scrollRootSelector)?.scrollTop ?? 0);
        return {
          x: Math.round(rect.left + scrollX),
          y: Math.round(rect.top + scrollY),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          viewportX: Math.round(rect.left),
          viewportY: Math.round(rect.top),
          viewportRect: {
            x: Math.round(rect.left),
            y: Math.round(rect.top),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          },
          sampleScrollY: scrollY,
        };
      },
      { selector: section.selector, scrollRootSelector, scrollRootIsWindow },
    );

    // If selector not found, wait 1 second and retry once — handles JS-rendered content
    if (!geo) {
      await page.waitForTimeout(1000);
      geo = await page.evaluate(
        ({ selector, scrollRootSelector, scrollRootIsWindow }) => {
          const el = document.querySelector(selector);
          if (!el) return null;
          const rect = el.getBoundingClientRect();
          const scrollX = scrollRootIsWindow ? window.scrollX : (document.querySelector(scrollRootSelector)?.scrollLeft ?? 0);
          const scrollY = scrollRootIsWindow ? window.scrollY : (document.querySelector(scrollRootSelector)?.scrollTop ?? 0);
          return {
            x: Math.round(rect.left + scrollX),
            y: Math.round(rect.top + scrollY),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
            viewportX: Math.round(rect.left),
            viewportY: Math.round(rect.top),
            viewportRect: {
              x: Math.round(rect.left),
              y: Math.round(rect.top),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
            },
            sampleScrollY: scrollY,
          };
        },
        { selector: section.selector, scrollRootSelector, scrollRootIsWindow },
      );
    }

    if (!geo) {
      console.warn(`[resolveGeometry] Selector not found after retry: "${section.selector}" (key: "${section.key}") on ${pageDef.url}`);
    }

    resolved.push({ ...section, ...(geo ?? {}) });

    if (section.stateConfig) {
      await page.evaluate(
        ({ scrollRootSelector, scrollRootIsWindow }) => {
          if (scrollRootIsWindow) {
            window.scrollTo(0, 0);
            return;
          }
          document.querySelector(scrollRootSelector)?.scrollTo(0, 0);
        },
        { scrollRootSelector, scrollRootIsWindow },
      );
    }
  }

  return resolved;
}

// ---------------------------------------------------------------------------
// applyStateConfig — scroll (and future actions) before measuring a state
// ---------------------------------------------------------------------------
async function applyStateConfig(page, stateConfig, scrollRootSelector, scrollRootIsWindow) {
  if (stateConfig == null) return;
  if (typeof stateConfig.scrollTo === "number") {
    await page.evaluate(
      ({ y, scrollRootSelector, scrollRootIsWindow }) => {
        if (scrollRootIsWindow) {
          window.scrollTo(0, y);
          return;
        }
        document.querySelector(scrollRootSelector)?.scrollTo(0, y);
      },
      { y: stateConfig.scrollTo, scrollRootSelector, scrollRootIsWindow },
    );
  }
}

// ---------------------------------------------------------------------------
// measurePage — full document dimensions needed by pageStitcher
// ---------------------------------------------------------------------------
export async function measurePage(page, scrollRootSelector, scrollRootIsWindow) {
  return page.evaluate(
    ({ scrollRootSelector, scrollRootIsWindow }) => {
      const root = scrollRootIsWindow
        ? document.scrollingElement || document.documentElement
        : document.querySelector(scrollRootSelector);
      const maxScrollY = scrollRootIsWindow
        ? Math.max(0, root.scrollHeight - window.innerHeight)
        : Math.max(0, root.scrollHeight - root.clientHeight);
      return {
        width: Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth || 0, window.innerWidth),
        height: Math.max(root.scrollHeight, document.documentElement.scrollHeight, document.body?.scrollHeight || 0, window.innerHeight),
        maxScrollY,
      };
    },
    { scrollRootSelector, scrollRootIsWindow },
  );
}
