import { measurePage } from "../utils/measurePage.js";

export async function buildDOMTree(url, browser, captureConfig) {
  const context = await browser.newContext({
    viewport: captureConfig.viewport,
    deviceScaleFactor: captureConfig.deviceScaleFactor,
  });

  try {
    const page = await context.newPage();

    await page.goto(url, {
      waitUntil: captureConfig.waitUntil,
      timeout: captureConfig.timeout,
    });

    const scrollRootSelector = null;
    const scrollRootIsWindow = true;

    const pageInfo = await measurePage(page, scrollRootSelector, scrollRootIsWindow);

    // Scroll to top so getBoundingClientRect() coords are document-absolute
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(300);

    const sectionTree = await page.evaluate(
      ({ pageInfo, captureConfig }) => {
        const { maxDepth } = captureConfig;
        const viewportHeight = window.innerHeight;
        const viewportWidth = window.innerWidth;

        // ── Visibility ───────────────────────────────────────────────────────
        function isVisible(el) {
          const style = window.getComputedStyle(el);
          if (style.display === "none") return false;
          if (style.visibility === "hidden") return false;
          if (parseFloat(style.opacity) === 0) return false;
          const r = el.getBoundingClientRect();
          if (r.width === 0 && r.height === 0) return false;
          return true;
        }

        function isValidSection(el) {
          if (!isVisible(el)) return false;
          const r = el.getBoundingClientRect();
          return r.height / viewportHeight > 0 || r.width / viewportWidth > 0; // || condition for element that has fixed out of flow position but still visible on screen
        }

        // ── Unique selector  ──────────────────────────────────
        function getUniqueSelector(element) {
          // ── try ID  ──────────────
          if (element.id) return `#${CSS.escape(element.id)}`;

          const tag = element.tagName.toLowerCase();
          const classes = [...element.classList].filter(Boolean);
          const SEMANTIC = new Set(["header", "footer", "main", "nav", "aside", "article", "section"]);

          function isUniqueSel(sel) {
            try {
              const matches = document.querySelectorAll(sel);
              return matches.length === 1 && matches[0] === element ? sel : null;
            } catch (e) {
              return null;
            }
          }

          // ── try semantic tag  ──────────────
          if (SEMANTIC.has(tag)) {
            const result = isUniqueSel(tag);
            if (result) return result;
          }

          // ── try  class  ──────────────
          for (const cls of classes) {
            const result = isUniqueSel(`.${CSS.escape(cls)}`);
            if (result) return result;
          }

          // ── try tag + class combinations  ──────────────
          for (const cls of classes) {
            const result = isUniqueSel(`${tag}.${CSS.escape(cls)}`);
            if (result) return result;
          }

          // ── try  class combinations  ──────────────
          for (let i = 0; i < classes.length; i++) {
            for (let j = i + 1; j < classes.length; j++) {
              const result = isUniqueSel(`${tag}.${CSS.escape(classes[i])}.${CSS.escape(classes[j])}`);
              if (result) return result;
            }
          }

          // ── try  fallback to structural  ──────────────
          function buildStructural(el, depth) {
            if (depth === 0 || !el || el === document.body) {
              return el ? el.tagName.toLowerCase() : "";
            }
            const parent = el.parentElement;
            if (!parent) return el.tagName.toLowerCase();
            const sameTag = [...parent.children].filter((c) => c.tagName === el.tagName);
            const idx = sameTag.indexOf(el) + 1;
            const nth = sameTag.length > 1 ? `:nth-of-type(${idx})` : "";
            const parentSel = buildStructural(parent, depth - 1);
            return `${parentSel} > ${el.tagName.toLowerCase()}${nth}`;
          }

          return buildStructural(element, 5);
        }

        function isScrollableElement(el, style) {
          const oy = style.overflowY;
          const ox = style.overflow;
          const hasScrollStyle = oy === "auto" || oy === "scroll" || ox === "auto" || ox === "scroll";
          return hasScrollStyle && el.scrollHeight > el.clientHeight + 18; // 18px tolerance for scrollbar
        }

        // ── Core recursive walk ───────────────────────────────────────────────
        function extractSections(el, depth) {
          if (depth > maxDepth) return [];

          const r = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          const validDirectChildren = Array.from(el.children).filter(isValidSection);

          return {
            tag: el.tagName.toLowerCase(),
            id: el.id || null,
            class: el.className || null,
            selector: getUniqueSelector(el),
            position: style.position || null,
            isScrollable: isScrollableElement(el, style),
            depth,
            geometry: {
              viewportTop: r.top,
              documentTop: r.top + window.scrollY,
              left: r.left + window.scrollX,
              width: r.width,
              height: r.height,
              ratioOfViewport: r.height / viewportHeight,
              ratioOfPage: r.height / pageInfo.height,
            },
            validChildrenCount: validDirectChildren.length,
            children: validDirectChildren.map((child) => extractSections(child, depth + 1)),
          };
        }

        return extractSections(document.body, 0);
      },
      { pageInfo, captureConfig },
    );

    return sectionTree;
  } catch (error) {
    throw error;
  } finally {
    await context.close();
  }
}

// =============================================================================
// PAGE CONFIG BUILDER — to be written step by step
// =============================================================================

// Step 1 complete ✓ — sectionExtractor with isScrollable
// Step 2 next    — constants + node accessors + utility filter
// Step 3         — findSections() recursive walker
// Step 4         — matchSections() multi-signal scorer
// Step 5         — pickSelector() + generateSectionName()
// Step 6         — buildPageConfig() + buildSiteConfig()
