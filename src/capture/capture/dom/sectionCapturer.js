import sharp from "sharp";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { normalizeStrip, normalizeToExactSize } from "./helpers/normalization.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STITCHED_DIR = path.resolve(__dirname, "..", "stitchedImages");

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getScrollRootState(page, scrollRootSelector, scrollRootIsWindow) {
  return page.evaluate(
    ({ scrollRootSelector, scrollRootIsWindow }) => {
      if (scrollRootIsWindow) {
        return {
          actualScrollY: window.scrollY,
          actualScrollX: window.scrollX,
          rootViewportTop: 0,
          rootViewportLeft: 0,
        };
      }

      const root = document.querySelector(scrollRootSelector);
      const rect = root.getBoundingClientRect();

      return {
        actualScrollY: root.scrollTop,
        actualScrollX: root.scrollLeft,
        rootViewportTop: rect.top,
        rootViewportLeft: rect.left,
      };
    },
    { scrollRootSelector, scrollRootIsWindow },
  );
}

export async function captureSections(page, extraction, captureConfig) {
  console.log("scrolling element in capture", extraction.scrollRootSelector, extraction.scrollRootIsWindow);
  const scrollEle = extraction.scrollRootSelector;
  const scrollIsWindow = extraction.scrollRootIsWindow;
  const sections = extraction.sections;
  const { viewport } = captureConfig;
  const VW = viewport.width;
  const VH = viewport.height;

  if (!fs.existsSync(STITCHED_DIR)) fs.mkdirSync(STITCHED_DIR, { recursive: true });

  // const pageInfo = await measurePage(page);
  const pageInfo = extraction.page;
  const capturedMapped = {};
  const floatingSelectors = sections
    .filter((s) => s.floating)
    .map((s) => s.selector)
    .filter(Boolean);

  console.log(`[capture] page=${pageInfo.width}x${pageInfo.height} viewport=${VW}x${VH}`);
  console.log(`[capture] ${sections.length} discovered visible sections`);

  await freezeCaptureState(page);

  for (const section of sections) {
    const key = section.key;
    console.log(`[capture] -> ${key} (${section.captureType})`);

    try {
      let captureResult;
      if (section.floating) {
        captureResult = await captureFloatingSection(page, section, VW, VH, scrollEle, scrollIsWindow);
      } else if (section.captureType === "absolute-clipped") {
        captureResult = await withFloatingHidden(
          page,
          floatingSelectors,
          async () => captureObservedSection(page, section, VW, VH, true, scrollEle, scrollIsWindow),
          section.selector,
        );
      } else {
        captureResult = await withFloatingHidden(
          page,
          floatingSelectors,
          async () => {
            if (section.captureType === "inner-scroll") {
              return captureInnerScrollSection(page, section, pageInfo, VW, VH, scrollEle, scrollIsWindow);
            }
            return captureDocumentSection(page, section, pageInfo, VW, VH, scrollEle, scrollIsWindow);
          },
          section.selector,
        );
      }

      const normalized = await normalizeToExactSize(captureResult.buffer, captureResult.width, captureResult.height);
      const imagePath = await saveSectionImage(key, normalized);

      capturedMapped[key] = {
        ...section,
        ...captureResult,
        buffer: normalized,
        imagePath,
        fullBuffer: captureResult.fullBuffer || null,
        expansion: captureResult.expansion || 0,
        floating: Boolean(section.floating),
        error: null,
      };
    } catch (err) {
      console.error(`[capture failed] ${key}: ${err.message}`);
      const placeholder = await placeholderBuffer(section.width, section.height);
      const imagePath = await saveSectionImage(`${key}_failed`, placeholder);
      capturedMapped[key] = {
        ...section,
        buffer: placeholder,
        imagePath,
        fullBuffer: null,
        expansion: 0,
        floating: Boolean(section.floating),
        error: err.message,
      };
    }
  }

  // await page.evaluate(() => window.scrollTo(0, 0));
  await page.evaluate(
    ({ scrollRootSelector, scrollRootIsWindow }) => {
      if (scrollRootIsWindow) {
        window.scrollTo(0, 0);
        return;
      }

      const scrollingElement = document.querySelector(scrollRootSelector);
      if (scrollingElement) {
        scrollingElement.scrollTo(0, 0);
      }
    },
    {
      scrollRootSelector: scrollEle,
      scrollRootIsWindow: scrollIsWindow,
    },
  );

  const failed = Object.values(capturedMapped).filter((s) => s.error).length;
  console.log(`[capture] summary: ${Object.keys(capturedMapped).length} captured, ${failed} failed`);
  return capturedMapped;
}

async function captureObservedSection(page, section, VW, VH, hideFloaters = false, scrollEle, scrollIsWindow) {
  const scrollY = Math.max(0, Math.round(section.sampleScrollY || 0));
  // await page.evaluate((y) => window.scrollTo(0, y), scrollY);
  await page.evaluate(
    ({ y, scrollRootSelector, scrollRootIsWindow }) => {
      if (scrollRootIsWindow) {
        window.scrollTo(0, y);
        return;
      }

      const scrollingElement = document.querySelector(scrollRootSelector);
      if (scrollingElement) {
        scrollingElement.scrollTo(0, y);
      }
    },
    {
      y: scrollY,
      scrollRootSelector: scrollEle,
      scrollRootIsWindow: scrollIsWindow,
    },
  );
  await waitForCaptureSettled(page, section.selector, 1800, 550);
  if (hideFloaters) {
    await hideCurrentlyFixedForNormal(page, section.selector);
    await waitForCaptureSettled(page, section.selector, 1800, 550);
  }

  const clip = section.viewportRect || {
    x: section.viewportX || 0,
    y: section.viewportY || 0,
    width: section.width,
    height: section.height,
  };

  const clipX = Math.max(0, Math.min(Math.round(clip.x), VW - 1));
  const clipY = Math.max(0, Math.min(Math.round(clip.y), VH - 1));
  const clipW = Math.max(1, Math.min(Math.round(clip.width), VW - clipX));
  const clipH = Math.max(1, Math.min(Math.round(clip.height), VH - clipY));

  const buffer = await page.screenshot({
    fullPage: false,
    clip: { x: clipX, y: clipY, width: clipW, height: clipH },
  });

  return {
    buffer,
    x: Math.max(0, Math.round(section.x)),
    y: Math.max(0, Math.round(section.y)),
    width: clipW,
    height: clipH,
    actualWidth: clipW,
    actualHeight: clipH,
    expansion: 0,
  };
}

async function measurePage(page) {
  return page.evaluate(() => {
    const scrollingElement = document.scrollingElement || document.documentElement;
    return {
      width: Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth || 0, window.innerWidth),
      height: Math.max(
        scrollingElement.scrollHeight,
        document.documentElement.scrollHeight,
        document.body?.scrollHeight || 0,
        window.innerHeight,
      ),
      maxScrollY: Math.max(0, scrollingElement.scrollHeight - window.innerHeight),
    };
  });
}

async function freezeCaptureState(page) {
  await page.evaluate(() => {
    document.documentElement.style.setProperty("scroll-behavior", "auto", "important");
    document.body.style.setProperty("scroll-behavior", "auto", "important");
    window.__captureMode = true;
  });
}

async function waitForCaptureSettled(page, selector = null, timeoutMs = 1600, minWaitMs = 450) {
  await page.evaluate(async (selector) => {
    if (document.fonts?.ready) {
      try {
        await document.fonts.ready;
      } catch (_) {
        // Font loading failures should not block capture.
      }
    }

    const decodeTargets = selector
      ? Array.from(document.querySelector(selector)?.querySelectorAll("img") || [])
      : Array.from(document.images || []);
    const decodeWithTimeout = (img) => {
      const decode = img.decode().catch(() => null);
      const timeout = new Promise((resolve) => setTimeout(resolve, 3000, null));
      return Promise.race([decode, timeout]);
    };

    await Promise.all(
      decodeTargets
        .filter((img) => img && !img.complete && typeof img.decode === "function")
        .slice(0, 20)
        .map(decodeWithTimeout),
    );
  }, selector);

  const start = Date.now();
  let previous = null;
  let stableChecks = 0;
  while (Date.now() - start < timeoutMs) {
    const current = await page.evaluate(captureVisualSignature, selector);

    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await wait(120);

    if (previous && previous === current) {
      stableChecks += 1;
    } else {
      stableChecks = 0;
    }

    if (stableChecks >= 3 && Date.now() - start >= minWaitMs) {
      return;
    }
    previous = current;
  }
}

function captureVisualSignature(selector) {
  const root = selector ? document.querySelector(selector) : document.body;
  if (!root) return "missing";

  const rootRect = root.getBoundingClientRect();
  const parts = [
    `scroll:${Math.round(window.scrollY)}`,
    `root:${Math.round(rootRect.left)},${Math.round(rootRect.top)},${Math.round(rootRect.width)},${Math.round(rootRect.height)}`,
  ];

  const nodes = [root, ...Array.from(root.querySelectorAll("*"))];
  let count = 0;
  for (const node of nodes) {
    if (count >= 90) break;
    const style = getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden") continue;
    const rect = node.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) continue;
    if (rect.bottom < 0 || rect.right < 0 || rect.top > window.innerHeight || rect.left > window.innerWidth) continue;

    const text = (node.innerText || node.getAttribute("alt") || node.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
    const isMedia = /^(IMG|VIDEO|CANVAS|SVG|PICTURE)$/.test(node.tagName);
    if (!text && !isMedia && rect.width * rect.height < 900) continue;

    parts.push(
      [
        node.tagName,
        Math.round(rect.left),
        Math.round(rect.top),
        Math.round(rect.width),
        Math.round(rect.height),
        Math.round(Number(style.opacity || 1) * 100),
        style.transform === "none" ? "none" : style.transform,
        text.slice(0, 32),
        isMedia ? node.currentSrc || node.src || node.getAttribute("src") || "media" : "",
      ].join("|"),
    );
    count += 1;
  }

  return parts.join("\n");
}

async function withFloatingHidden(page, selectors, fn, currentSelector = null) {
  const selectorsToHide = selectors.filter((selector) => selector && selector !== currentSelector);
  await page.evaluate(
    ({ selectors, currentSelector }) => {
      const current = currentSelector ? document.querySelector(currentSelector) : null;
      const selectorSet = new Set(selectors);
      document.querySelectorAll("*").forEach((el) => {
        const style = getComputedStyle(el);
        if (style.position === "fixed" || style.position === "sticky") {
          if (el.id) selectorSet.add(`#${CSS.escape(el.id)}`);
          else {
            const classes = Array.from(el.classList).filter(Boolean).slice(0, 2);
            if (classes.length) selectorSet.add(`${el.tagName.toLowerCase()}.${classes.map((c) => CSS.escape(c)).join(".")}`);
          }
        }
      });

      window.__hiddenForNormalCapture ||= [];
      for (const selector of selectorSet) {
        const el = document.querySelector(selector);
        if (!el || el.dataset.__captureHidden === "1") continue;
        if (current && (el === current || el.contains(current) || current.contains(el))) continue;
        window.__hiddenForNormalCapture.push({
          element: el,
          selector,
          visibility: el.style.visibility,
          opacity: el.style.opacity,
          pointerEvents: el.style.pointerEvents,
        });
        el.dataset.__captureHidden = "1";
        el.style.setProperty("visibility", "hidden", "important");
        el.style.setProperty("opacity", "0", "important");
        el.style.setProperty("pointer-events", "none", "important");
      }
    },
    { selectors: selectorsToHide, currentSelector },
  );

  try {
    return await fn();
  } finally {
    await page.evaluate(() => {
      for (const item of window.__hiddenForNormalCapture || []) {
        const el = item.element || (item.selector ? document.querySelector(item.selector) : null);
        if (!el) continue;
        el.style.visibility = item.visibility;
        el.style.opacity = item.opacity;
        el.style.pointerEvents = item.pointerEvents;
        delete el.dataset.__captureHidden;
      }
      window.__hiddenForNormalCapture = [];
    });
  }
}

async function captureDocumentSection(page, section, pageInfo, VW, VH, scrollEle, scrollIsWindow) {
  // Detect zero-geometry sections early — this means the selector was not found
  // in the DOM during resolveGeometry. Throw so sectionCapturer records an error
  // rather than capturing a meaningless 1×1 placeholder.
  if (!section.width || !section.height) {
    throw new Error(`Section "${section.key}" has zero geometry (selector "${section.selector}" not found in the DOM)`);
  }

  const targetX = Math.max(0, Math.round(section.x));
  const targetY = Math.max(0, Math.round(section.y));
  const targetW = Math.max(1, Math.min(Math.round(section.width), VW - Math.min(targetX, VW - 1), pageInfo.width - targetX));
  const targetH = Math.max(1, Math.min(Math.round(section.height), pageInfo.height - targetY));

  if (targetW < 1 || targetH < 1) throw new Error(`invalid section size ${targetW}x${targetH}`);

  const strips = [];
  let capturedHeight = 0;
  let guard = 0;

  while (capturedHeight < targetH && guard < 200) {
    guard += 1;
    const absoluteY = targetY + capturedHeight;
    const scrollTarget = Math.max(0, Math.min(absoluteY - 8, pageInfo.maxScrollY));

    // await page.evaluate((y) => window.scrollTo(0, y), scrollTarget);
    await page.evaluate(
      ({ y, scrollRootSelector, scrollRootIsWindow }) => {
        if (scrollRootIsWindow) {
          window.scrollTo(0, y);
          return;
        }

        const scrollingELement = document.querySelector(scrollRootSelector);
        if (scrollingELement) {
          scrollingELement.scrollTo(0, y);
        }
      },
      {
        y: scrollTarget,
        scrollRootSelector: scrollEle,
        scrollRootIsWindow: scrollIsWindow,
      },
    );

    await waitForCaptureSettled(page, section.selector, 1400, 400);
    await hideCurrentlyFixedForNormal(page, section.selector);
    await waitForCaptureSettled(page, section.selector, 1400, 400);

    // const actualScrollY = await page.evaluate(() => window.scrollY);
    const { actualScrollY, rootViewportTop } = await getScrollRootState(page, scrollEle, scrollIsWindow);
    // const clipY = Math.max(0, Math.round(absoluteY - actualScrollY));
    const clipY = scrollIsWindow
      ? Math.max(0, Math.round(absoluteY - actualScrollY))
      : Math.max(0, Math.round(rootViewportTop + absoluteY - actualScrollY));
    const clipX = Math.max(0, Math.min(targetX, VW - 1));
    const remaining = targetH - capturedHeight;
    const clipH = Math.max(1, Math.min(remaining, VH - clipY));
    const clipW = Math.max(1, Math.min(targetW, VW - clipX));

    if (clipY >= VH || clipH < 1 || clipW < 1) {
      throw new Error(`section not visible at y=${absoluteY}, scroll=${actualScrollY}`);
    }

    const buffer = await page.screenshot({
      fullPage: false,
      clip: { x: clipX, y: clipY, width: clipW, height: clipH },
    });

    strips.push({ buffer: await normalizeStrip(buffer, clipW, clipH), height: clipH, width: clipW });
    capturedHeight += clipH;
  }

  if (capturedHeight < targetH) throw new Error(`incomplete capture ${capturedHeight}/${targetH}`);

  const stitched = await stitchVerticalStrips(strips, targetW, targetH);
  return {
    buffer: stitched,
    x: targetX,
    y: targetY,
    width: targetW,
    height: targetH,
    actualWidth: targetW,
    actualHeight: targetH,
    expansion: 0,
  };
}

async function captureFloatingSection(page, section, VW, VH, scrollEle, scrollIsWindow) {
  const scrollY = Math.max(0, Math.round(section.sampleScrollY || 0));
  // await page.evaluate((y) => window.scrollTo(0, y), scrollY);
  await page.evaluate(
    ({ y, scrollRootSelector, scrollRootIsWindow }) => {
      if (scrollRootIsWindow) {
        window.scrollTo(0, y);
        return;
      }

      const scrollingELement = document.querySelector(scrollRootSelector);
      if (scrollingELement) {
        scrollingELement.scrollTo(0, y);
      }
    },
    {
      y: scrollY,
      scrollRootSelector: scrollEle,
      scrollRootIsWindow: scrollIsWindow,
    },
  );

  await waitForCaptureSettled(page, section.selector, 1800, 550);

  const expanded = await captureExpandedFloatingElement(page, section, VW, VH);
  if (expanded) return expanded;

  const rect = await page.evaluate((selector) => {
    const el = document.querySelector(selector);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
      x: Math.max(0, Math.round(r.left)),
      y: Math.max(0, Math.round(r.top)),
      width: Math.round(Math.min(r.width, window.innerWidth - Math.max(0, r.left))),
      height: Math.round(Math.min(r.height, window.innerHeight - Math.max(0, r.top))),
    };
  }, section.selector);

  const observedClip = section.viewportRect || {
    x: section.viewportX || 0,
    y: section.viewportY || 0,
    width: section.width,
    height: section.height,
  };
  const rectLooksUseful =
    rect && rect.width >= Math.max(8, observedClip.width * 0.5) && rect.height >= Math.max(8, observedClip.height * 0.5);
  const clip = rectLooksUseful ? rect : observedClip;
  const clipX = Math.max(0, Math.min(Math.round(clip.x), VW - 1));
  const clipY = Math.max(0, Math.min(Math.round(clip.y), VH - 1));
  const clipW = Math.max(1, Math.min(Math.round(clip.width), VW - clipX));
  const clipH = Math.max(1, Math.min(Math.round(clip.height), VH - clipY));

  const buffer = await page.screenshot({
    fullPage: false,
    clip: { x: clipX, y: clipY, width: clipW, height: clipH },
  });

  return {
    buffer,
    x: section.x,
    y: section.y,
    width: clipW,
    height: clipH,
    actualWidth: clipW,
    actualHeight: clipH,
    expansion: 0,
  };
}

async function hideCurrentlyFixedForNormal(page, currentSelector) {
  await page.evaluate((currentSelector) => {
    const current = currentSelector ? document.querySelector(currentSelector) : null;
    window.__hiddenForNormalCapture ||= [];

    document.querySelectorAll("*").forEach((el) => {
      const style = getComputedStyle(el);
      if (style.position !== "fixed" && style.position !== "sticky") return;
      if (current && (el === current || el.contains(current) || current.contains(el))) return;
      if (el.dataset.__captureHidden === "1") return;

      window.__hiddenForNormalCapture.push({
        selector: el.id ? `#${CSS.escape(el.id)}` : null,
        element: el,
        visibility: el.style.visibility,
        opacity: el.style.opacity,
        pointerEvents: el.style.pointerEvents,
      });
      el.dataset.__captureHidden = "1";
      el.style.setProperty("visibility", "hidden", "important");
      el.style.setProperty("opacity", "0", "important");
      el.style.setProperty("pointer-events", "none", "important");
    });
  }, currentSelector);
}

async function captureExpandedFloatingElement(page, section, VW, VH) {
  const shouldExpand = /isi|safety|important_safety|sticky/i.test(`${section.key} ${section.selector} ${section.text || ""}`);
  if (!shouldExpand || !section.selector) return null;

  const meta = await page.evaluate((selector) => {
    const source = document.querySelector(selector);
    if (!source) return null;

    const rect = source.getBoundingClientRect();
    const fullHeight = Math.max(source.scrollHeight, source.offsetHeight, rect.height);
    const fullWidth = Math.max(source.scrollWidth, source.offsetWidth, rect.width);
    if (fullHeight <= rect.height + 20) return null;

    const old = document.getElementById("__EXPANDED_FLOAT_CAPTURE__");
    if (old) old.remove();

    const clone = source.cloneNode(true);
    clone.querySelectorAll("*").forEach((child) => {
      const style = getComputedStyle(child);
      if (style.position === "fixed" || style.position === "sticky" || style.position === "absolute") {
        child.style.setProperty("position", "static", "important");
      }
      child.style.setProperty("transform", "none", "important");
      child.style.setProperty("max-height", "none", "important");
      child.style.setProperty("overflow", "visible", "important");
      if (child.scrollHeight > child.clientHeight) {
        child.style.setProperty("height", `${child.scrollHeight}px`, "important");
      }
    });

    clone.style.setProperty("position", "static", "important");
    clone.style.setProperty("display", "block", "important");
    clone.style.setProperty("visibility", "visible", "important");
    clone.style.setProperty("opacity", "1", "important");
    clone.style.setProperty("transform", "none", "important");
    clone.style.setProperty("width", `${Math.ceil(Math.min(fullWidth, window.innerWidth))}px`, "important");
    clone.style.setProperty("height", "auto", "important");
    clone.style.setProperty("max-height", "none", "important");
    clone.style.setProperty("overflow", "visible", "important");
    clone.style.setProperty("background", getComputedStyle(source).backgroundColor || "#ffffff", "important");

    const stage = document.createElement("div");
    stage.id = "__EXPANDED_FLOAT_CAPTURE__";
    stage.style.setProperty("position", "absolute", "important");
    stage.style.setProperty("left", "0px", "important");
    stage.style.setProperty("top", `${window.scrollY}px`, "important");
    stage.style.setProperty("z-index", "2147483647", "important");
    stage.style.setProperty("background", "#ffffff", "important");
    stage.style.setProperty("overflow", "visible", "important");
    stage.style.setProperty("width", `${Math.ceil(Math.min(fullWidth, window.innerWidth))}px`, "important");
    stage.appendChild(clone);
    document.body.appendChild(stage);

    const stageRect = stage.getBoundingClientRect();
    const height = Math.ceil(Math.max(stage.scrollHeight, clone.scrollHeight, clone.offsetHeight));
    stage.style.setProperty("height", `${height}px`, "important");

    return {
      x: Math.max(0, Math.round(stageRect.left)),
      y: Math.max(0, Math.round(stageRect.top)),
      docY: Math.max(0, Math.round(window.scrollY + stageRect.top)),
      width: Math.ceil(Math.min(fullWidth, window.innerWidth)),
      height,
    };
  }, section.selector);

  if (!meta || meta.width < 10 || meta.height < 10) return null;

  await wait(80);
  const fullPageBuffer = await page.screenshot({ fullPage: true });
  await page.evaluate(() => document.getElementById("__EXPANDED_FLOAT_CAPTURE__")?.remove());

  const fullMeta = await sharp(fullPageBuffer).metadata();
  const clipW = Math.max(1, Math.min(meta.width, fullMeta.width - meta.x));
  const clipH = Math.max(1, Math.min(meta.height, fullMeta.height - meta.docY));
  const buffer = await sharp(fullPageBuffer).extract({ left: meta.x, top: meta.docY, width: clipW, height: clipH }).png().toBuffer();

  return {
    buffer,
    x: section.x,
    y: section.y,
    width: clipW,
    height: clipH,
    actualWidth: clipW,
    actualHeight: clipH,
    expansion: 0,
    expandedFloating: true,
  };
}

async function captureInnerScrollSection(page, section, pageInfo, VW, VH, scrollEle, scrollIsWindow) {
  const selector = section.selector;
  const exists = await page.evaluate((sel) => Boolean(document.querySelector(sel)), selector);
  // if (!exists) return captureDocumentSection(page, section, await measurePage(page), VW, VH, scrollEle, scrollIsWindow);
  if (!exists) return captureDocumentSection(page, section, pageInfo, VW, VH, scrollEle, scrollIsWindow);

  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (el) el.scrollTop = 0;
  }, selector);

  const metrics = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      x: Math.round(r.left + window.scrollX),
      y: Math.round(r.top + window.scrollY),
      viewportX: Math.round(r.left),
      viewportY: Math.round(r.top),
      width: Math.round(r.width),
      height: Math.round(r.height),
    };
  }, selector);

  if (!metrics || metrics.scrollHeight <= metrics.clientHeight + 24) {
    return captureDocumentSection(page, section, pageInfo, VW, VH, scrollEle, scrollIsWindow);
  }

  const scrollTarget = Math.max(0, metrics.y - 8);
  await page.evaluate((y) => window.scrollTo(0, y), scrollTarget);
  await wait(100);

  const strips = [];
  let scrollTop = 0;
  let guard = 0;

  while (guard < 120) {
    guard += 1;
    const pos = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {
        scrollTop: el.scrollTop,
        x: Math.max(0, Math.round(r.left)),
        y: Math.max(0, Math.round(r.top)),
        width: Math.round(Math.min(r.width, window.innerWidth - Math.max(0, r.left))),
        height: Math.round(Math.min(r.height, window.innerHeight - Math.max(0, r.top))),
      };
    }, selector);
    if (!pos) break;

    const clipW = Math.max(1, Math.min(pos.width, VW - pos.x));
    const clipH = Math.max(1, Math.min(pos.height, VH - pos.y));
    const buffer = await page.screenshot({ fullPage: false, clip: { x: pos.x, y: pos.y, width: clipW, height: clipH } });
    strips.push({ buffer: await normalizeStrip(buffer, clipW, clipH), height: clipH, width: clipW, scrollTop: pos.scrollTop });

    const next = Math.min(metrics.scrollHeight - metrics.clientHeight, scrollTop + metrics.clientHeight);
    if (next <= scrollTop) break;
    await page.evaluate(
      ({ sel, top }) => {
        const el = document.querySelector(sel);
        if (el) el.scrollTop = top;
      },
      { sel: selector, top: next },
    );
    await wait(90);
    const actual = await page.evaluate((sel) => document.querySelector(sel)?.scrollTop || 0, selector);
    if (actual <= scrollTop) break;
    scrollTop = actual;
    if (scrollTop >= metrics.scrollHeight - metrics.clientHeight) {
      // Capture the final scrolled state on the next loop.
      continue;
    }
  }

  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (el) el.scrollTop = 0;
  }, selector);

  if (!strips.length) return captureDocumentSection(page, section, pageInfo, VW, VH, scrollEle, scrollIsWindow);

  const fullHeight = Math.max(
    metrics.scrollHeight,
    strips.reduce((sum, s) => sum + s.height, 0),
  );
  const width = Math.max(...strips.map((s) => s.width));
  const composites = [];
  let top = 0;

  for (let i = 0; i < strips.length; i++) {
    const current = strips[i];
    const nextScroll = i + 1 < strips.length ? strips[i + 1].scrollTop : metrics.scrollHeight;
    const newRows = Math.max(1, Math.min(current.height, nextScroll - current.scrollTop));
    const cropped = await sharp(current.buffer).extract({ left: 0, top: 0, width: current.width, height: newRows }).png().toBuffer();
    composites.push({ input: cropped, left: 0, top });
    top += newRows;
  }

  const fullBuffer = await sharp({
    create: { width, height: top, channels: 4, background: { r: 245, g: 245, b: 245, alpha: 255 } },
  })
    .composite(composites)
    .png()
    .toBuffer();

  return {
    buffer: fullBuffer,
    fullBuffer,
    x: section.x,
    y: section.y,
    width,
    height: top,
    actualWidth: width,
    actualHeight: top,
    expansion: Math.max(0, top - section.height),
  };
}

async function stitchVerticalStrips(strips, targetW, targetH) {
  if (strips.length === 1 && strips[0].width === targetW && strips[0].height === targetH) return strips[0].buffer;

  const composites = [];
  let top = 0;
  for (const strip of strips) {
    let input = strip.buffer;
    if (strip.width !== targetW) {
      input = await sharp(input)
        .extend({
          right: targetW - strip.width,
          background: { r: 245, g: 245, b: 245, alpha: 255 },
        })
        .png()
        .toBuffer();
    }
    composites.push({ input, left: 0, top });
    top += strip.height;
  }

  return sharp({
    create: { width: targetW, height: targetH, channels: 4, background: { r: 245, g: 245, b: 245, alpha: 255 } },
  })
    .composite(composites)
    .png()
    .toBuffer();
}

async function placeholderBuffer(width, height) {
  return sharp({
    create: {
      width: Math.max(1, Math.round(width)),
      height: Math.max(1, Math.round(height)),
      channels: 4,
      background: { r: 220, g: 220, b: 220, alpha: 180 },
    },
  })
    .png()
    .toBuffer();
}

async function saveSectionImage(key, buffer) {
  const safeKey = key.replace(/[:\\/*?"<>|.#\[\]\s]/g, "_").slice(0, 130);
  const outPath = path.join(STITCHED_DIR, `${safeKey}_${Date.now()}.png`);
  await sharp(buffer).png().toFile(outPath);
  return outPath;
}
