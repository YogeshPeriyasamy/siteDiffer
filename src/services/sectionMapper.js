import { measurePage } from "../utils/measurePage.js";

export async function sectionExtractor(url, browser, captureConfig) {
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

    // Scroll to top so getBoundingClientRect() coords are from document top
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(300);

    const sectionTree = await page.evaluate(
      ({ pageInfo, captureConfig }) => {
        const { minSectionRatio, maxDepth } = captureConfig;

        // Viewport height is the denominator — getBoundingClientRect() is viewport-relative
        const viewportHeight = window.innerHeight;
        const viewportWidth = window.innerWidth;

        // ── Absolute rect: adds scrollY so coords are document-relative ──────
        function getAbsoluteRect(el) {
          const r = el.getBoundingClientRect();
          return {
            top: r.top + window.scrollY,
            left: r.left + window.scrollX,
            width: r.width,
            height: r.height,
            bottom: r.top + window.scrollY + r.height,
          };
        }

        // ── Visibility check ─────────────────────────────────────────────────
        function isVisible(el) {
          const style = window.getComputedStyle(el);
          if (style.display === "none") return false;
          if (style.visibility === "hidden") return false;
          if (parseFloat(style.opacity) === 0) return false;
          const r = el.getBoundingClientRect();
          if (r.width === 0 && r.height === 0) return false;
          return true;
        }

        // ── Is this element a valid section candidate ────────────────────────
        function isValidSection(el) {
          // if (!BLOCK_TAGS.has(el.tagName.toLowerCase())) return false;
          if (!isVisible(el)) return false;
          const r = el.getBoundingClientRect();
          return r.height / viewportHeight > 0 || r.width / viewportWidth > 0;
        }

        // ── Unique CSS selector for a given element ──────────────────────────
        // Strategy: find the SHORTEST selector that resolves to exactly this
        // element at extraction time, validated live via querySelectorAll.
        // Avoids full class chains which break when JS toggles any one class.
        function getUniqueSelector(element) {
          // P1: stable id — always unique by spec
          if (element.id) return `#${CSS.escape(element.id)}`;

          const tag = element.tagName.toLowerCase();
          const classes = [...element.classList].filter(Boolean);

          const SEMANTIC = new Set(["header", "footer", "main", "nav", "aside", "article", "section"]);

          // Try a selector and return it only if it uniquely matches this element
          function tryExact(sel) {
            try {
              const matches = document.querySelectorAll(sel);
              return matches.length === 1 && matches[0] === element ? sel : null;
            } catch (e) {
              return null;
            }
          }

          // P2: semantic tag alone (header, footer, nav etc. are usually unique)
          if (SEMANTIC.has(tag)) {
            const result = tryExact(tag);
            if (result) return result;
          }

          // P3: single class alone
          for (const cls of classes) {
            const result = tryExact(`.${CSS.escape(cls)}`);
            if (result) return result;
          }

          // P4: tag + single class
          for (const cls of classes) {
            const result = tryExact(`${tag}.${CSS.escape(cls)}`);
            if (result) return result;
          }

          // P5: tag + two classes
          for (let i = 0; i < classes.length; i++) {
            for (let j = i + 1; j < classes.length; j++) {
              const result = tryExact(`${tag}.${CSS.escape(classes[i])}.${CSS.escape(classes[j])}`);
              if (result) return result;
            }
          }

          // P6: structural fallback — parent selector + tag:nth-of-type(n)
          //     No class dependency at all, so it survives JS class toggling.
          function buildStructural(el, maxDepth) {
            if (maxDepth === 0 || !el || el === document.body) {
              return el ? el.tagName.toLowerCase() : "";
            }
            const parent = el.parentElement;
            if (!parent) return el.tagName.toLowerCase();

            const sameTag = [...parent.children].filter((c) => c.tagName === el.tagName);
            const idx = sameTag.indexOf(el) + 1;
            const nth = sameTag.length > 1 ? `:nth-of-type(${idx})` : "";
            const parentSel = buildStructural(parent, maxDepth - 1);
            return `${parentSel} > ${el.tagName.toLowerCase()}${nth}`;
          }

          return buildStructural(element, 5);
        }

        // ── Core recursive function ──────────────────────────────────────────
        function extractSections(el, depth) {
          if (depth > maxDepth) return [];

          const r = el.getBoundingClientRect();
          const validDirectChildren = Array.from(el.children).filter(isValidSection);

          const style = window.getComputedStyle(el);

          return {
            tag: el.tagName.toLowerCase(),
            id: el.id || null,
            class: el.className || null,
            selector: getUniqueSelector(el),
            position: style.position || null,
            depth,
            geometry: {
              viewportTop: r.top, // position from current viewport top
              documentTop: r.top + window.scrollY, // position from document top (absolute)
              left: r.left + window.scrollX,
              width: r.width,
              height: r.height,
              ratioOfViewport: r.height / viewportHeight, // how much of the viewport it covers
              ratioOfPage: r.height / pageInfo.height, // how much of the full page it covers
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
// PAGE CONFIG BUILDER
//
// Converts two DOM hierarchy trees (live + staging, from sectionExtractor)
// into a sites.js-compatible page config:
//
//   { live: { sections: [...] }, staging: { sections: [...] } }
//
// Pipeline:
//   tree → collectSectionCandidates
//        → createStableKey
//        → matchSections (by key, never by index)
//        → generateSectionName (once per matched pair)
//        → generateUniqueSelector (per side independently)
//        → determineCaptureType / determineFloating
//        → buildPageConfig  ← main entry point
// =============================================================================

// Auto-generated ID pattern — not stable across environments
const AUTO_ID = /^(div|span|el|block|node|react|vue|ng|ember|gatsby|next|svelte)[_-]?\d+$/i;

// Utility / framework-generated class pattern — skip in keys and selectors
// Catches: Tailwind responsive prefixes (xl:, sm:), hyphenated utilities,
// numbered utilities, and common single-word Tailwind layout classes.
const UTILITY_CLASS = /^([a-z]{1,3}-[a-z0-9_-]+|[a-z]+-[a-z0-9_-]+|[a-z]+\d+|_[a-z0-9]+|\w+:\w+)$/;

// Specific Tailwind/CSS words that look like stable classes but are purely
// layout/utility — must never be used as stable keys or selectors.
const TAILWIND_UTILITY_WORDS = new Set([
  // positioning
  "relative",
  "absolute",
  "fixed",
  "sticky",
  "static",
  // display
  "flex",
  "grid",
  "block",
  "inline",
  "hidden",
  "contents",
  "table",
  // overflow
  "overflow",
  "overflow-hidden",
  "overflow-auto",
  "overflow-scroll",
  "overflow-visible",
  // sizing
  "container",
  "w-full",
  "h-full",
  "h-auto",
  "w-auto",
  // flex/grid
  "flex-col",
  "flex-row",
  "flex-wrap",
  "items-center",
  "items-start",
  "items-end",
  "justify-center",
  "justify-between",
  "justify-start",
  "justify-end",
  // typography
  "font-bold",
  "font-light",
  "font-normal",
  "font-medium",
  "uppercase",
  "lowercase",
  "text-center",
  "text-left",
  "text-right",
  // accessibility — off-screen, never visual
  "sr-only",
  // transforms / transitions
  "transform",
  "transition",
  "duration",
  // misc layout
  "rounded",
  "shadow",
  "border",
  "cursor",
  "pointer",
  "select",
  "truncate",
  "underline",
  "italic",
]);

// ─────────────────────────────────────────────────────────────────────────────
// NODE ACCESSORS — read geometry/style from the sectionExtractor output shape
// ─────────────────────────────────────────────────────────────────────────────

function _getChildren(node) {
  return node.children || [];
}

function _getPosition(node) {
  // sectionExtractor stores position at node.position
  return node.position || "static";
}

function _hasGeometry(node) {
  const g = node.geometry || {};
  return g.width > 0 && g.height > 0;
}

function _isFixedOrSticky(node) {
  const pos = _getPosition(node);
  return pos === "fixed" || pos === "sticky";
}

function _isInFlowPosition(node) {
  const pos = _getPosition(node);
  return pos === "static" || pos === "relative" || pos === "sticky";
}

function _isDefinitelyHidden(node) {
  // display:none is the only hard stop — visibility:hidden can be
  // overridden by children so we don't stop on it
  return node.display === "none";
}

function _getDocTop(node) {
  return node.geometry?.documentTop ?? 0;
}

function _getHeight(node) {
  return node.geometry?.height ?? 0;
}

function _getClassList(node) {
  const cls = node.class || node.className || "";
  return typeof cls === "string" ? cls.split(/\s+/).filter(Boolean) : [];
}

// Returns true if a class name is a utility/framework-generated class that
// must NOT be used as a stable identity or selector.
function _isUtilityClass(cls) {
  if (!cls) return true;
  if (TAILWIND_UTILITY_WORDS.has(cls)) return true;
  if (UTILITY_CLASS.test(cls)) return true;
  return false;
}

function _hasAnyVisibleDescendant(node) {
  for (const child of _getChildren(node)) {
    if (_isDefinitelyHidden(child)) continue;
    if (_isFixedOrSticky(child)) return true;
    if (_hasGeometry(child)) return true;
    if (_hasAnyVisibleDescendant(child)) return true;
  }
  return false;
}

// Returns true for elements that exist only for accessibility/SEO and are
// deliberately hidden from visual rendering (sr-only, off-screen positioned).
// These must never become visual section candidates.
function _isAccessibilityOnly(node) {
  const classes = _getClassList(node);
  // sr-only class: clipped to 1x1px off-screen
  if (classes.includes("sr-only")) return true;
  // documentTop < 0: element is positioned above the page top (off-screen)
  const docTop = node.geometry?.documentTop ?? 0;
  if (docTop < 0) return true;
  return false;
}

function _findFirstHeadingText(node) {
  if (/^h[1-6]$/.test(node.tag || "")) {
    const text = node.textContent || node.text || node.innerText || "";
    return text.trim() || null;
  }
  for (const child of _getChildren(node)) {
    const found = _findFirstHeadingText(child);
    if (found) return found;
  }
  return null;
}

// Annotates every node in the tree with _parentRef for upward traversal.
// Called once per tree before any other processing.
function _annotateParentRefs(node, parent) {
  node._parentRef = parent;
  for (const child of _getChildren(node)) {
    _annotateParentRefs(child, node);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// STAGE 1 — SECTION BOUNDARY DETECTION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * isVerticalSectionContainer
 *
 * Returns true when a node's direct visible children form independent
 * vertically ordered capture regions (i.e. the node is a layout container).
 *
 * Only uses geometry to determine LAYOUT RELATIONSHIP between siblings —
 * never to reject individual small elements.
 *
 * Rules:
 *   - Needs 2+ visible children
 *   - Not all children out-of-flow (that means layered component)
 *   - In-flow children must have average vertical overlap < 15%
 *     (15% tolerance handles sticky headers, negative margins, etc.)
 */
function isVerticalSectionContainer(node, children) {
  const visible = children.filter((c) => !_isDefinitelyHidden(c));
  if (visible.length < 2) return false;

  const inFlow = visible.filter(_isInFlowPosition);
  const outOfFlow = visible.filter((c) => !_isInFlowPosition(c));

  // All out-of-flow = layered component (hero with absolute layers)
  if (outOfFlow.length === visible.length) return false;

  // Need at least 2 in-flow children for vertical ordering
  if (inFlow.length < 2) return false;

  const sorted = [...inFlow].sort((a, b) => _getDocTop(a) - _getDocTop(b));

  let totalOverlapRatio = 0;
  let pairs = 0;

  for (let i = 1; i < sorted.length; i++) {
    const prevBottom = _getDocTop(sorted[i - 1]) + _getHeight(sorted[i - 1]);
    const currTop = _getDocTop(sorted[i]);
    const prevHeight = _getHeight(sorted[i - 1]);
    const overlap = Math.max(0, prevBottom - currTop);
    totalOverlapRatio += overlap / Math.max(prevHeight, 1);
    pairs++;
  }

  if (pairs === 0) return false;
  return totalOverlapRatio / pairs < 0.15;
}

/**
 * collectSectionCandidates
 *
 * Walks the DOM hierarchy tree and returns a flat ordered array of
 * candidate nodes. Each candidate represents one independent capture region.
 *
 * Rules (in order):
 *   1. display:none subtrees → skip entirely
 *   2. Fixed/sticky elements → always independent candidates
 *   3. Zero-geometry node → traverse into children (may have fixed descendants)
 *   4. Node fits within one viewport (ratioOfViewport <= 1) → take it as a
 *      section directly, do NOT recurse into its children
 *   5. Node is a vertical section container → recurse into its children
 *   6. Otherwise → node itself is the candidate
 *
 * SIZE IS NEVER USED TO REJECT A CANDIDATE.
 */
function collectSectionCandidates(node, parent = null) {
  if (_isDefinitelyHidden(node)) return [];

  // Accessibility-only elements (sr-only, off-screen) must never be sections
  if (_isAccessibilityOnly(node)) return [];

  // Fixed/sticky → always an independent section
  if (_isFixedOrSticky(node) && parent !== null) return [node];

  // Zero-geometry → traverse through (may wrap a fixed/absolute child)
  if (!_hasGeometry(node)) {
    if (!_hasAnyVisibleDescendant(node)) return [];
    const results = [];
    for (const child of _getChildren(node)) {
      results.push(...collectSectionCandidates(child, node));
    }
    return results;
  }

  // Viewport-fit check: if the node fits within one viewport height it is
  // already a manageable capture unit — take it as a section without
  // descending into its children.
  // ratioOfViewport is set by sectionExtractor as: height / window.innerHeight
  // A ratio <= 1.0 means the element height is at most one full viewport tall.
  const ratioOfViewport = node.geometry?.ratioOfViewport ?? 0;
  if (parent !== null && ratioOfViewport > 0 && ratioOfViewport <= 1.0) {
    return [node];
  }

  const children = _getChildren(node).filter((c) => !_isDefinitelyHidden(c));

  // Node is a vertical section container → recurse into children
  if (isVerticalSectionContainer(node, children)) {
    const results = [];
    for (const child of children) {
      if (_isDefinitelyHidden(child)) continue;

      // Fixed/sticky children are always independent
      if (_isFixedOrSticky(child)) {
        results.push(child);
        continue;
      }

      // Zero-geometry child → traverse through it
      if (!_hasGeometry(child)) {
        if (_hasAnyVisibleDescendant(child)) {
          results.push(...collectSectionCandidates(child, node));
        }
        continue;
      }

      // Child is itself a container → recurse further
      if (isVerticalSectionContainer(child, _getChildren(child))) {
        results.push(...collectSectionCandidates(child, node));
      } else {
        // Child is an independent section boundary — take it as-is
        results.push(child);
      }
    }
    return results;
  }

  // Node has geometry but is not a container → it IS the section candidate
  if (parent !== null) return [node];

  // Root (body) → always recurse
  const results = [];
  for (const child of children) {
    results.push(...collectSectionCandidates(child, node));
  }
  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// STAGE 2 — STABLE KEY (cross-environment matching identity)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * createStableKey
 *
 * Produces a stable identity key used for live↔staging matching.
 * Never used as a CSS selector.
 *
 * Priority: stable id → data-* → aria-label → stable class → structural
 */
function createStableKey(node) {
  // P1: stable non-auto id
  if (node.id && !AUTO_ID.test(node.id)) return `id:${node.id}`;

  // P2: data identity attributes
  const d = node.dataset || {};
  const dataId = d.testid || d["section-id"] || d.section || d.name || d.id || d.cy || d.qa;
  if (dataId) return `data:${dataId}`;

  // P3: aria-label (short enough to be an identifier)
  const ariaLabel = node.ariaLabel || node["aria-label"];
  if (ariaLabel && ariaLabel.split(/\s+/).length <= 6) {
    return `aria:${ariaLabel.trim().toLowerCase()}`;
  }

  // P4: first stable (non-utility) class combination
  const stableClasses = _getClassList(node).filter((c) => !_isUtilityClass(c));
  if (stableClasses.length > 0) {
    return `class:${stableClasses.slice(0, 2).join(".")}`;
  }

  // P5: structural fallback — parentTag > tag[siblingIndex]
  const parent = node._parentRef;
  const parentTag = parent ? parent.tag : "root";
  const tagSiblings = parent ? _getChildren(parent).filter((c) => c.tag === node.tag) : [];
  const idx = tagSiblings.indexOf(node);
  return `struct:${parentTag}>${node.tag}[${Math.max(idx, 0)}]`;
}

// ─────────────────────────────────────────────────────────────────────────────
// STAGE 3 — SECTION NAME GENERATION (once per matched pair)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * normalizeName
 *
 * Converts technical identifiers to readable display names.
 *   Doctor_discussion_guide_parent → Doctor Discussion Guide
 *   Educational_brochure           → Educational Brochure
 */
function normalizeName(raw) {
  const STRIP_SUFFIXES = /[\s_-]*(parent|container|wrapper|section|inner|outer|wrap|holder|box)$/gi;
  return raw
    .replace(/[_-]+/g, " ")
    .replace(STRIP_SUFFIXES, "")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * generateSectionName
 *
 * Priority:
 *   data-section → data-name → aria-label → first heading → id → stable class
 *   → semantic tag → null (caller supplies "Section N")
 */
function generateSectionName(node) {
  const d = node.dataset || {};
  if (d.section) return normalizeName(d.section);
  if (d.name) return normalizeName(d.name);

  const ariaLabel = node.ariaLabel || node["aria-label"];
  if (ariaLabel && ariaLabel.split(/\s+/).length <= 6) {
    return normalizeName(ariaLabel);
  }

  const heading = _findFirstHeadingText(node);
  if (heading && heading.split(/\s+/).length <= 8) return normalizeName(heading);

  if (node.id && !AUTO_ID.test(node.id)) return normalizeName(node.id);

  const stableClass = _getClassList(node).find((c) => !_isUtilityClass(c));
  if (stableClass) return normalizeName(stableClass);

  const semanticNames = {
    header: "Header",
    footer: "Footer",
    nav: "Navigation",
    main: "Main",
    aside: "Sidebar",
    article: "Article",
  };
  if (semanticNames[node.tag]) return semanticNames[node.tag];

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// STAGE 4 — SELECTOR GENERATION (per side independently)
// ─────────────────────────────────────────────────────────────────────────────

function _cssEscape(value) {
  if (typeof CSS !== "undefined" && CSS.escape) return CSS.escape(value);
  return String(value).replace(/([!"#$%&'()*+,.\/:;<=>?@[\\\]^`{|}~])/g, "\\$1");
}

function _buildStructuralSelector(node, maxDepth) {
  const parts = [];
  let current = node;
  let depth = 0;

  while (current && current.tag !== "body" && current.tag !== "html" && depth < maxDepth) {
    const parent = current._parentRef;
    if (!parent) break;

    const sameTag = _getChildren(parent).filter((c) => c.tag === current.tag);
    const idx = sameTag.indexOf(current);
    const nth = sameTag.length > 1 ? `:nth-of-type(${idx + 1})` : "";
    parts.unshift(`${current.tag}${nth}`);

    current = parent;
    depth++;
  }

  return parts.join(" > ");
}

/**
 * generateUniqueSelector
 *
 * Generates the shortest selector that (according to isUnique) resolves to
 * exactly one element on the page.
 *
 * Priority: #id → [data-*] → .class → tag.class → structural
 *
 * isUnique(sel) must be a sync or async function returning boolean.
 */
async function generateUniqueSelector(node, isUnique) {
  const trySelector = async (sel) => {
    try {
      return (await isUnique(sel)) ? sel : null;
    } catch {
      return null;
    }
  };

  // P1: stable id
  if (node.id && !AUTO_ID.test(node.id)) {
    const sel = `#${_cssEscape(node.id)}`;
    if (await trySelector(sel)) return sel;
  }

  // P2: data attributes
  const d = node.dataset || {};
  for (const attr of ["testid", "section-id", "section", "name", "cy", "qa"]) {
    const val = d[attr];
    if (val) {
      const sel = `[data-${attr}="${_cssEscape(val)}"]`;
      if (await trySelector(sel)) return sel;
    }
  }

  // P3: single stable class
  const stableClasses = _getClassList(node).filter((c) => !_isUtilityClass(c));
  if (stableClasses.length > 0) {
    const sel = `.${_cssEscape(stableClasses[0])}`;
    if (await trySelector(sel)) return sel;

    // P4: tag + stable class
    const sel2 = `${node.tag}.${_cssEscape(stableClasses[0])}`;
    if (await trySelector(sel2)) return sel2;

    // P4b: two stable classes
    if (stableClasses.length >= 2) {
      const sel3 = `.${_cssEscape(stableClasses[0])}.${_cssEscape(stableClasses[1])}`;
      if (await trySelector(sel3)) return sel3;
    }
  }

  // P5: use the selector already computed by sectionExtractor (fully qualified,
  // includes nth-of-type chains from html > body) — most reliable fallback
  if (node.selector) return node.selector;

  // P6: structural fallback (last resort)
  return _buildStructuralSelector(node, 5);
}

// ─────────────────────────────────────────────────────────────────────────────
// STAGE 5 — CAPTURE TYPE & FLOATING
// ─────────────────────────────────────────────────────────────────────────────

function determineCaptureType(node) {
  const pos = _getPosition(node);
  if (pos === "fixed") return "fixed";
  if (pos === "sticky") return "sticky";
  return "normal";
}

function determineFloating(node) {
  const ct = determineCaptureType(node);
  return ct === "fixed" || ct === "sticky";
}

// ─────────────────────────────────────────────────────────────────────────────
// STAGE 6 — MATCHING (by stable key, never by array index)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * matchSections
 *
 * Produces a unified list where each entry has:
 *   { key, live: node|null, staging: node|null, liveOrder, stagingOrder }
 *
 * Matching is strictly by stable key.
 * Both sides preserve their own DOM order independently.
 */
function matchSections(liveCandidates, stagingCandidates) {
  const liveMap = new Map();
  const stagingMap = new Map();

  for (const node of liveCandidates) {
    const key = createStableKey(node);
    if (!liveMap.has(key)) liveMap.set(key, node);
  }

  for (const node of stagingCandidates) {
    const key = createStableKey(node);
    if (!stagingMap.has(key)) stagingMap.set(key, node);
  }

  const liveOrder = new Map(liveCandidates.map((n, i) => [createStableKey(n), i]));
  const stagingOrder = new Map(stagingCandidates.map((n, i) => [createStableKey(n), i]));

  const allKeys = new Set([...liveMap.keys(), ...stagingMap.keys()]);

  const entries = [...allKeys].map((key) => ({
    key,
    live: liveMap.get(key) || null,
    staging: stagingMap.get(key) || null,
    liveOrder: liveOrder.get(key) ?? Infinity,
    stagingOrder: stagingOrder.get(key) ?? Infinity,
  }));

  // Primary sort by staging order (most complete/current side).
  // Live-only entries are placed at their live position + 0.5 so they
  // interleave naturally between staging entries.
  entries.sort((a, b) => {
    const aOrder = a.stagingOrder !== Infinity ? a.stagingOrder : a.liveOrder + 0.5;
    const bOrder = b.stagingOrder !== Infinity ? b.stagingOrder : b.liveOrder + 0.5;
    return aOrder - bOrder;
  });

  return entries;
}

// ─────────────────────────────────────────────────────────────────────────────
// STAGE 7 — UNIQUENESS CHECKER (tree-based, no browser required)
// ─────────────────────────────────────────────────────────────────────────────

function _makeTreeUniquenessChecker(tree) {
  const counts = new Map();

  function walk(node) {
    if (node.id && !AUTO_ID.test(node.id)) {
      const k = `#${node.id}`;
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    for (const cls of _getClassList(node)) {
      if (_isUtilityClass(cls)) continue;
      const k = `.${cls}`;
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    for (const child of _getChildren(node)) walk(child);
  }

  walk(tree);

  return (sel) => {
    if (sel.startsWith("#") || sel.startsWith(".")) {
      return (counts.get(sel) || 0) === 1;
    }
    // Compound selectors assumed unique (no browser to validate)
    return true;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN ENTRY POINT — buildPageConfig
// ─────────────────────────────────────────────────────────────────────────────

/**
 * buildPageConfig
 *
 * Takes the DOM hierarchy trees from sectionExtractor for LIVE and STAGING
 * and returns a page config in sites.js format:
 *
 *   {
 *     live:    { page, path, scrollIsWindow, scrollRoot, sections: [...] },
 *     staging: { page, path, scrollIsWindow, scrollRoot, sections: [...] }
 *   }
 *
 */
export async function buildPageConfig({
  liveTree,
  stagingTree,
  pageName,
  path,
  scrollIsWindow = true,
  scrollRoot = null,
  isLiveUnique = null,
  isStagingUnique = null,
  excludeKeys = new Set(),
}) {
  // Annotate parent refs — required for stable key + structural selector
  _annotateParentRefs(liveTree, null);
  _annotateParentRefs(stagingTree, null);

  // Stage 1: candidates
  const liveCandidates = collectSectionCandidates(liveTree, null);
  const stagingCandidates = collectSectionCandidates(stagingTree, null);

  // Stage 2: match
  const matches = matchSections(liveCandidates, stagingCandidates);

  // Stage 3: uniqueness validators (tree-based fallback when no browser available)
  const liveUnique = isLiveUnique || _makeTreeUniquenessChecker(liveTree);
  const stagingUnique = isStagingUnique || _makeTreeUniquenessChecker(stagingTree);

  // Stage 4: build live sections in LIVE DOM order
  const liveEntries = matches.filter((m) => m.live && !excludeKeys.has(m.key)).sort((a, b) => a.liveOrder - b.liveOrder);

  let liveCounter = 1;
  const liveSections = await Promise.all(
    liveEntries.map(async (m) => {
      const node = m.live;
      const name = generateSectionName(node) || `Section ${liveCounter++}`;
      const selector = await generateUniqueSelector(node, liveUnique);
      return {
        section: name,
        selector,
        state: [],
        captureType: determineCaptureType(node),
        floating: determineFloating(node),
      };
    }),
  );

  // Stage 5: build staging sections in STAGING DOM order
  const stagingEntries = matches.filter((m) => m.staging && !excludeKeys.has(m.key)).sort((a, b) => a.stagingOrder - b.stagingOrder);

  let stagingCounter = 1;
  const stagingSections = await Promise.all(
    stagingEntries.map(async (m) => {
      const node = m.staging;
      // Use live node for name generation when available (keeps names consistent)
      const nameNode = m.live || node;
      const name = generateSectionName(nameNode) || `Section ${stagingCounter++}`;
      const selector = await generateUniqueSelector(node, stagingUnique);
      return {
        section: name,
        selector,
        state: [],
        captureType: determineCaptureType(node),
        floating: determineFloating(node),
      };
    }),
  );

  const base = { page: pageName, path, scrollIsWindow, scrollRoot };

  return {
    live: { ...base, sections: liveSections },
    staging: { ...base, sections: stagingSections },
  };
}
