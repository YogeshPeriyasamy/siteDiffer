import sharp from "sharp";

// =============================================================================
// HELPERS
// =============================================================================
async function unlockScroll(page) {
  return page.evaluate(() => {
    const restore = [];

    // Patch an element's CSS property and record the original value for restore.
    // Instead of storing the DOM node (which cannot cross the evaluate boundary),
    // we assign a unique "data-fp-unlock" attribute so restoreCSS can re-query
    // the element by that attribute inside a fresh evaluate call.
    let unlockCounter = 0;
    function patch(el, prop, value) {
      // Mark the element with a unique restore key the first time we touch it
      if (!el.hasAttribute("data-fp-unlock")) {
        el.setAttribute("data-fp-unlock", `fpu-${unlockCounter++}`);
      }
      const key = el.getAttribute("data-fp-unlock");
      restore.push({ key, prop, original: el.style.getPropertyValue(prop), priority: el.style.getPropertyPriority(prop) });
      el.style.setProperty(prop, value, "important");
    }

    // Check if window is already naturally scrollable
    const alreadyScrollable =
      document.documentElement.scrollHeight > window.innerHeight + 50 &&
      getComputedStyle(document.documentElement).overflow !== "hidden" &&
      getComputedStyle(document.body).overflow !== "hidden";

    if (alreadyScrollable) return restore; // nothing to do

    let scrollRoot = null;
    const allEls = Array.from(document.querySelectorAll("*"));

    for (const el of allEls) {
      if (el == document.documentElement || el == document.body) continue;
      const style = getComputedStyle(el);
      const overflowY = style.overflowY;
      const isScrollable = overflowY === "auto" || overflowY === "scroll";
      const isScrollableAndHasContent = isScrollable && el.scrollHeight > el.clientHeight + 50;
      if (isScrollableAndHasContent) {
        scrollRoot = el;
        break;
      }
    }

    if (!scrollRoot) return restore;

    let node = scrollRoot;
    while (node && node !== document.documentElement) {
      patch(node, "overflow", "visible");
      patch(node, "overflow-y", "visible");
      patch(node, "height", "auto");
      patch(node, "max-height", "none");
      node = node.parentElement;
    }

    // Make html + body the actual scroll container
    patch(document.documentElement, "overflow", "auto");
    patch(document.documentElement, "overflow-y", "auto");
    patch(document.documentElement, "height", "auto");
    patch(document.body, "overflow", "auto");
    patch(document.body, "overflow-y", "auto");
    patch(document.body, "height", "auto");

    return restore; // we'll use this to undo everything later
  });
}

async function classifyFixedElements(page, viewportWidth, viewportHeight) {
  const result = await page.evaluate(
    ({ VW, VH }) => {
      const headerEls = [];
      const isiEls = [];
      const otherFixedEls = [];

      let counter = 0;

      document.querySelectorAll("*").forEach((el) => {
        const style = getComputedStyle(el);
        const pos = style.position;

        if (pos !== "fixed" && pos !== "sticky") return;
        if (style.display === "none" || style.visibility === "hidden") return;
        const rect = el.getBoundingClientRect();
        if (rect.width < 10 || rect.height < 10) return;

        // Assign a guaranteed-unique data attribute so we can reliably find this
        // element again later — class/id selectors are ambiguous and fragile.
        // We use setAttribute directly (not dataset) so the attribute name is
        // exactly "data-fp-capture" with no double-dash surprises.
        const attrValue = `fp-${counter++}`;
        el.setAttribute("data-fp-capture", attrValue);

        const descriptor = {
          // This selector is always unique — no fallback to tag names
          selector: `[data-fp-capture="${attrValue}"]`,
          rect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
        };

        const isTopAligned = rect.top < 120; // near the top = header
        const isWide = rect.width >= VW * 0.7; // spans 70%+ width = header/nav bar
        const isNavHeight = rect.height < 200; // real nav bars are compact — hero backgrounds are tall (400px+). 200px threshold handles tall navs like 153px headers
        const isInTopZone = rect.top + rect.height < 250; // element fully sits within top 250px zone — covers 153px headers with buffer
        const isBottomHalf = rect.top > VH * 0.45; // lower half of viewport = ISI
        const isTallEnough = rect.height > 50; // taller than 50px = not a thin rule

        if (isInTopZone && isNavHeight) {
          // Any compact fixed/sticky element sitting entirely within the top 200px
          // zone belongs to the header area — this catches nav bars, social bars,
          // announcement strips, etc. regardless of their width.
          headerEls.push(descriptor);
        } else if (isTopAligned && isWide && !isNavHeight) {
          // Wide + top-aligned but tall (e.g. hero background with position:fixed for parallax)
          // Do NOT classify, do NOT hide — leave it visible so the hero renders correctly
        } else if (isBottomHalf && isTallEnough) {
          isiEls.push(descriptor);
        } else {
          otherFixedEls.push(descriptor);
        }
      });

      return { headerEls, isiEls, otherFixedEls };
    },
    { VW: viewportWidth, VH: viewportHeight },
  );

  // Log what was classified so we can verify the right elements are targeted
  console.log(
    `[fullPageCapture] Headers classified   (${result.headerEls.length}):`,
    result.headerEls.map((e) => e.selector),
  );
  console.log(
    `[fullPageCapture] ISI classified       (${result.isiEls.length}):`,
    result.isiEls.map((e) => e.selector),
  );
  console.log(
    `[fullPageCapture] Other fixed classified (${result.otherFixedEls.length}):`,
    result.otherFixedEls.map((e) => e.selector),
  );

  return result;
}

// ---------------------------------------------------------------------------
// compositeHeader is no longer needed.
// Strip 1 is taken before the header is hidden so the header appears
// naturally at the top of the stitched image without any compositing.
// ---------------------------------------------------------------------------

async function hideElements(page, descriptors) {
  if (!descriptors.length) return [];

  return page.evaluate((descs) => {
    const restoreData = [];
    for (const desc of descs) {
      const el = document.querySelector(desc.selector);
      if (!el) continue;

      // Store original values so we can restore exactly
      restoreData.push({
        selector: desc.selector,
        visibility: el.style.visibility,
        opacity: el.style.opacity,
        pointerEvents: el.style.pointerEvents,
      });

      // Hide the element
      el.style.setProperty("visibility", "hidden", "important");
      el.style.setProperty("opacity", "0", "important");
      el.style.setProperty("pointer-events", "none", "important");
    }

    return restoreData;
  }, descriptors);
}

async function measureFullPage(page) {
  return page.evaluate(() => ({
    pageHeight: Math.max(
      document.body.scrollHeight,
      document.documentElement.scrollHeight,
      document.body.offsetHeight,
      document.documentElement.offsetHeight,
    ),
    pageWidth: Math.max(document.body.scrollWidth, document.documentElement.scrollWidth),
  }));
}

async function waitForStripStability(page, timeoutMs, minWaitMs, stableChecks) {
  const start = Date.now();
  let previous = null,
    stableCount = 0;

  while (Date.now() - start < timeoutMs) {
    // Build a lightweight "fingerprint" of the visible DOM
    const sig = await page.evaluate(() => {
      const parts = [`scroll:${Math.round(window.scrollY)}`];
      const nodes = Array.from(document.body.querySelectorAll("*")).slice(0, 60);
      for (const node of nodes) {
        const style = getComputedStyle(node);
        if (style.display === "none" || style.visibility === "hidden") continue;
        const rect = node.getBoundingClientRect();
        if (rect.width < 2 || rect.height < 2) continue;
        if (rect.bottom < 0 || rect.top > window.innerHeight) continue;
        parts.push(`${Math.round(rect.left)},${Math.round(rect.top)},${Math.round(rect.width)},${Math.round(rect.height)}`);
        if (parts.length > 30) break;
      }
      return parts.join("|");
    });

    await page.waitForTimeout(120);

    if (previous === sig) stableCount++;
    else stableCount = 0;

    // Only declare stable if we've seen the same signature stableChecks times
    // AND we've been waiting at least minWaitMs total
    if (stableCount >= stableChecks && Date.now() - start >= minWaitMs) return;
    previous = sig;
  }
  // Timeout reached — capture anyway
}

// Captures the first strip at scrollY=0 with header still visible.
// Returns { buffer, scrollY: 0 }
async function captureFirstStrip(page, VW, VH, STABILITY_TIMEOUT, MIN_WAIT_MS, STABLE_CHECKS, RAF_SETTLE_COUNT, SCROLL_SETTLE_MS) {
  await page.evaluate(() => window.scrollTo(0, 0));

  await page.evaluate(
    (n) =>
      new Promise((resolve) => {
        let ticks = 0;
        function tick() {
          if (++ticks >= n) resolve();
          else requestAnimationFrame(tick);
        }
        requestAnimationFrame(tick);
      }),
    RAF_SETTLE_COUNT,
  );
  await page.waitForTimeout(SCROLL_SETTLE_MS);
  await waitForStripStability(page, STABILITY_TIMEOUT, MIN_WAIT_MS, STABLE_CHECKS);

  const buffer = await page.screenshot({
    fullPage: false,
    clip: { x: 0, y: 0, width: VW, height: VH },
  });

  console.log(`[fullPageCapture] strip 1 (with header) scrollY=0`);
  return { buffer, scrollY: 0 };
}

// Captures strips from scrollY=stepSize onwards (header already hidden).
async function captureRemainingStrips(
  page,
  VW,
  VH,
  pageHeight,
  OVERLAP_PX,
  SCROLL_SETTLE_MS,
  RAF_SETTLE_COUNT,
  STABLE_CHECKS,
  STABILITY_TIMEOUT,
  MIN_WAIT_MS,
) {
  const stepSize = VH - OVERLAP_PX;
  const maxScrollY = Math.max(0, pageHeight - VH);
  const strips = [];

  // Safety: if scroll gets stuck (page intercepting scrollTo or smooth-scroll still active)
  // break after MAX_STUCK consecutive strips at the same position to avoid infinite loop.
  let lastActualScrollY = -1;
  let stuckCount        = 0;
  const MAX_STUCK       = 3;

  // Start from stepSize — strip 1 (scrollY=0) was already captured with the header
  let targetScrollY = stepSize;

  // If page is shorter than one viewport there are no remaining strips
  if (maxScrollY <= 0) return strips;

  while (true) {
    // Use scrollTop assignment directly — bypasses Next.js / SPA router scroll
    // interception that fights window.scrollTo() calls.
    // Set __fpScrollStarted so the window.scrollTo patch blocks any reset-to-0.
    await page.evaluate((y) => {
      window.__fpScrollStarted = true;
      document.documentElement.scrollTop = y;
      document.body.scrollTop = y; // Safari fallback
    }, targetScrollY);

    await page.evaluate(
      (n) =>
        new Promise((resolve) => {
          let ticks = 0;
          function tick() {
            if (++ticks >= n) resolve();
            else requestAnimationFrame(tick);
          }
          requestAnimationFrame(tick);
        }),
      RAF_SETTLE_COUNT,
    );
    await page.waitForTimeout(SCROLL_SETTLE_MS);
    await waitForStripStability(page, STABILITY_TIMEOUT, MIN_WAIT_MS, STABLE_CHECKS);

    const actualScrollY = await page.evaluate(() => Math.round(window.scrollY));

    // Stuck-scroll detection — break before capturing a duplicate strip
    if (actualScrollY === lastActualScrollY) {
      stuckCount++;
      if (stuckCount >= MAX_STUCK) {
        console.warn(`[fullPageCapture] Scroll stuck at scrollY=${actualScrollY} after ${stuckCount} attempts — breaking loop`);
        break;
      }
    } else {
      stuckCount = 0;
    }
    lastActualScrollY = actualScrollY;

    const buffer = await page.screenshot({
      fullPage: false,
      clip: { x: 0, y: 0, width: VW, height: VH },
    });

    strips.push({ buffer, scrollY: actualScrollY });
    console.log(`[fullPageCapture] strip scrollY=${actualScrollY} target=${targetScrollY}`);

    if (actualScrollY >= maxScrollY) break;

    targetScrollY = Math.min(actualScrollY + stepSize, maxScrollY);
  }

  return strips;
}

async function stitchStrips(strips, pageWidth, pageHeight, VW, VH) {
  const composites = [];

  for (const strip of strips) {
    let input = strip.buffer;
    const meta = await sharp(input).metadata();

    // If strip is narrower than canvas (shouldn't happen but guard anyway)
    if (meta.width < pageWidth) {
      input = await sharp(input)
        .extend({ right: pageWidth - meta.width, background: { r: 245, g: 245, b: 245, alpha: 255 } })
        .png()
        .toBuffer();
    }

    composites.push({
      input,
      left: 0,
      top: Math.min(strip.scrollY, pageHeight - 1), // clamp so nothing goes out of canvas
    });
  }

  return sharp({
    create: { width: pageWidth, height: pageHeight, channels: 3, background: { r: 255, g: 255, b: 255 } },
  })
    .composite(composites) // sharp composites in array order — later entries overwrite earlier
    .png()
    .toBuffer();
}

// ---------------------------------------------------------------------------
// stitchStrips — places each strip at its scrollY position on the canvas.
// Strip 1 (scrollY=0, captured with header visible) sits at the top.
// Later strips (header hidden) overwrite only the zones below headerHeight.
// ---------------------------------------------------------------------------

async function restoreElements(page, restoreData) {
  await page.evaluate((data) => {
    for (const item of data) {
      const el = document.querySelector(item.selector);
      if (!el) continue;
      el.style.visibility = item.visibility ?? "";
      el.style.opacity = item.opacity ?? "";
      el.style.pointerEvents = item.pointerEvents ?? "";
      // Clean up the marker attribute we added during classification
      el.removeAttribute("data-fp-capture");
    }
  }, restoreData);
}

async function restoreCSS(page, restoreData) {
  if (!restoreData || restoreData.length === 0) return;
  // DOM nodes cannot be serialized across the evaluate boundary — they arrive
  // as undefined. We re-query each element using the "data-fp-unlock" attribute
  // that was stamped on it during unlockScroll, then remove the attribute.
  await page.evaluate((data) => {
    for (const item of data) {
      const el = document.querySelector(`[data-fp-unlock="${item.key}"]`);
      if (!el) continue;
      if (item.original) {
        el.style.setProperty(item.prop, item.original, item.priority ?? "");
      } else {
        el.style.removeProperty(item.prop);
      }
    }
    // Clean up all unlock markers in one pass
    document.querySelectorAll("[data-fp-unlock]").forEach((el) => el.removeAttribute("data-fp-unlock"));
  }, restoreData);
}

// =============================================================================
// MAIN
// =============================================================================
export async function captureFullPage(page, captureConfig) {
  const VW = captureConfig.viewport.width;
  const VH = captureConfig.viewport.height;
  const { OVERLAP_PX, SCROLL_SETTLE_MS, RAF_SETTLE_COUNT, STABLE_CHECKS, STABILITY_TIMEOUT, MIN_WAIT_MS } = captureConfig;

  // ── Phase 0 — unlock scroll for fixed-body sites ─────────────────────────
  const cssRestoreData = await unlockScroll(page);

  // ── Phase 1 — classify fixed/sticky elements ─────────────────────────────
  const { headerEls, isiEls, otherFixedEls } = await classifyFixedElements(page, VW, VH);

  // ── Phase 2 — hide ISI + other fixed (NOT the header yet) ────────────────
  // The header must stay visible for strip 1 so it appears naturally at top.
  const nonHeaderRestoreData = await hideElements(page, [...isiEls, ...otherFixedEls]);

  // ── Phase 3 — measure full page (after hiding ISI/other fixed) ───────────
  const { pageHeight, pageWidth } = await measureFullPage(page);
  console.log(`[fullPageCapture] page=${pageWidth}×${pageHeight}  viewport=${VW}×${VH}`);

  // ── Phase 3b — disable smooth scroll + lock scroll restoration globally ──
  // Must be done before ANY scrollTo call.
  // 1. scroll-behavior:smooth causes window.scrollY to read 0 mid-animation.
  // 2. Next.js / SPA routers intercept window.scrollTo() and reset to 0.
  //    Setting scrollTop directly bypasses the router's scroll handler.
  //    history.scrollRestoration = 'manual' stops browser scroll restoration.
  //    Patching window.scrollTo blocks any framework reset-to-0 calls during capture.
  // 3. Lenis / Locomotive Scroll virtual scroll libraries keep window.scrollY=0
  //    permanently by using CSS transform instead of real scroll. Destroy them first.
  await page.evaluate(() => {
    // ── Kill virtual scroll libraries (Lenis, Locomotive Scroll) ─────────
    // These libs lock window.scrollY at 0 and scroll via transform — must be
    // destroyed before any scrollTo call will work.
    try {
      if (window.lenis) {
        window.lenis.destroy();
        window.lenis = null;
      }
    } catch (_) {}

    try {
      if (window.locomotiveScroll) {
        window.locomotiveScroll.destroy();
        window.locomotiveScroll = null;
      }
    } catch (_) {}

    // Remove transforms applied by virtual scroll containers
    const virtualContainers = document.querySelectorAll(
      "[data-scroll-container], [data-lenis-container], .lenis, [data-locomotive-scroll]",
    );
    virtualContainers.forEach((el) => {
      el.style.removeProperty("transform");
      el.style.removeProperty("will-change");
      el.style.setProperty("position", "static", "important");
    });

    // Reset html/body that virtual scroll libs lock to overflow:hidden
    document.documentElement.style.setProperty("overflow", "auto", "important");
    document.documentElement.style.setProperty("height",   "auto", "important");
    document.body.style.setProperty("overflow", "auto", "important");
    document.body.style.setProperty("height",   "auto", "important");

    // ── Kill smooth scroll ────────────────────────────────────────────────
    document.documentElement.style.setProperty("scroll-behavior", "auto", "important");
    document.body.style.setProperty("scroll-behavior", "auto", "important");

    // ── Stop browser scroll restoration ──────────────────────────────────
    if (window.history?.scrollRestoration) {
      window.history.scrollRestoration = "manual";
    }

    // ── Patch window.scrollTo to block framework reset-to-0 calls ────────
    window.__fpPreventScrollReset = true;
    const orig = window.scrollTo.bind(window);
    window.__fpOrigScrollTo = orig;
    window.scrollTo = (x, y) => {
      if (y === 0 && window.__fpScrollStarted) return; // block reset-to-0 after loop starts
      orig(x, y);
    };
  });

  // Re-measure after virtual scroll teardown — layout may have changed
  const { pageHeight: remeasuredHeight, pageWidth: remeasuredWidth } = await measureFullPage(page);
  if (remeasuredHeight !== pageHeight || remeasuredWidth !== pageWidth) {
    console.log(`[fullPageCapture] Re-measured after scroll teardown: ${remeasuredWidth}×${remeasuredHeight}`);
  }
  const finalPageHeight = remeasuredHeight;
  const finalPageWidth  = remeasuredWidth;

  // ── Phase 4 — capture strip 1 at scrollY=0 WITH header visible ───────────
  // This gives us the header + hero + all initial content in one natural shot.
  const firstStrip = await captureFirstStrip(
    page,
    VW,
    VH,
    STABILITY_TIMEOUT,
    MIN_WAIT_MS,
    STABLE_CHECKS,
    RAF_SETTLE_COUNT,
    SCROLL_SETTLE_MS,
  );

  // ── Phase 5 — now hide the header too before scrolling further ───────────
  const headerRestoreData = await hideElements(page, headerEls);

  // ── Phase 6 — capture remaining strips (header + ISI both hidden) ────────
  const remainingStrips = await captureRemainingStrips(
    page,
    VW,
    VH,
    finalPageHeight,
    OVERLAP_PX,
    SCROLL_SETTLE_MS,
    RAF_SETTLE_COUNT,
    STABLE_CHECKS,
    STABILITY_TIMEOUT,
    MIN_WAIT_MS,
  );

  // ── Phase 7 — stitch all strips into one image ───────────────────────────
  // Strip 1 (scrollY=0) is placed at top=0 with header visible.
  // Remaining strips (header hidden) are placed at their actual scrollY.
  // Where strips overlap the later one overwrites — seamless result.
  const allStrips = [firstStrip, ...remainingStrips];
  const finalBuffer = await stitchStrips(allStrips, finalPageWidth, finalPageHeight, VW, VH);

  // ── Phase 8 — restore everything ─────────────────────────────────────────
  await restoreElements(page, [...nonHeaderRestoreData, ...headerRestoreData]);
  await restoreCSS(page, cssRestoreData);
  // Restore the patched window.scrollTo and scroll flags before handing page back
  await page.evaluate(() => {
    if (window.__fpOrigScrollTo) {
      window.scrollTo = window.__fpOrigScrollTo;
      delete window.__fpOrigScrollTo;
    }
    delete window.__fpPreventScrollReset;
    delete window.__fpScrollStarted;
  });
  await page.evaluate(() => window.scrollTo(0, 0));

  return finalBuffer;
}
