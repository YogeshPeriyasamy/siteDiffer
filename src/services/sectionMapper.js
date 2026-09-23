import { measurePage } from "../utils/measurePage.js";
import { autoID, utilitySelectors, utilityWords } from "./sectionMapper.constants.js";
import { stabilizePage } from "../stabilize/index.js";

// =============================================================================
// DOM tree builder
// =============================================================================
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

    await stabilizePage(page);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(300);

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
          const text = getTextContent(el);
          const isSpacer = !text && el.children.length == 0;
          if (isSpacer) return false;
          const r = el.getBoundingClientRect();
          return r.height / viewportHeight > 0 || r.width / viewportWidth > 0; // || condition for element that has fixed out of flow position but still visible on screen
        }

        function getTextContent(el) {
          const text = (el.innerText || "").replace(/\s+/g, " ").trim();
          return text ? text.slice(0, 100) : null; // limit to 100 chars
        }

        // ── Unique selector  ──────────────────────────────────
        function getUniqueSelector(el) {
          // ── try ID  ──────────────
          if (el.id) return `#${CSS.escape(el.id)}`;

          const tag = el.tagName.toLowerCase();
          const classes = [...el.classList].filter(Boolean);
          const SEMANTIC = new Set(["header", "footer", "main", "nav", "aside", "article", "section"]);

          function isUniqueSel(sel) {
            try {
              const matches = document.querySelectorAll(sel);
              return matches.length === 1 && matches[0] === el ? sel : null;
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
            return parentSel ? `${parentSel} > ${el.tagName.toLowerCase()}${nth}` : `${el.tagName.toLowerCase()}${nth}`;
          }

          return buildStructural(el, 5);
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
            dataset: el.dataset ? Object.fromEntries(Object.entries(el.dataset)) : {},
            class: el.className || null,
            selector: getUniqueSelector(el),
            position: style.position || null,
            isScrollable: isScrollableElement(el, style),
            textPreview: getTextContent(el),
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
// section extractor helpers
// =============================================================================
function findSections(node, parent = null) {
  if (isOffscreen(node)) return [];
  if (!hasBox(node)) {
    return hasanyBox(node) ? getChildren(node).flatMap((c) => findSections(c, node)) : [];
  }

  //if floater
  if (isFloater(node)) return [node];

  // ── Viewport-fit → section ────────────────────────────────────────────────
  const ratio = node.geometry?.ratioOfViewport || 0;
  if (parent !== null && ratio > 0 && ratio <= 1.3 && !isVerticalContainer(node)) return [node];

  // ── Transparent single-child wrapper → peel and recurse ── Applied at every level so 3–5 nested wrappers are all peeled
  const visible = getChildren(node).filter((c) => !isOffscreen(c));
  const inFlow = visible.filter((c) => isInFlow(c));
  const fixed = visible.filter((c) => isFloater(c));

  if (inFlow.length === 1) {
    const sole = inFlow[0];
    const parentH = getHeight(node);
    const soleH = getHeight(sole);
    if (hasBox(sole) && parentH > 0 && soleH / parentH >= 0.9) {
      // Surface any fixed siblings (e.g. sticky-isi inside a wrapper)
      const fixedSections = fixed.flatMap((fc) => findSections(fc, node));
      // Recurse into the sole in-flow child with the original parent context
      return [...fixedSections, ...findSections(sole, node)];
    }
  }

  // ── Vertical container → recurse into children ────────────────────────────
  if (isVerticalContainer(node)) {
    const results = [];
    for (const child of getChildren(node)) {
      if (isOffscreen(child)) continue;
      if (isFloater(child)) {
        results.push(child);
        continue;
      }
      if (!hasBox(child)) {
        if (hasanyBox(child)) results.push(...findSections(child, node));
        continue;
      }
      // Viewport-fit child with no fixed descendants → take as section
      const cr = child.geometry?.ratioOfViewport;
      if (cr > 0 && cr <= 1.3 && !hasFloaterDesc(child)) {
        results.push(child);
      } else {
        results.push(...findSections(child, node));
      }
    }
    return results;
  }

  // ── Fallback → section ────────────────────────────────────────────────────
  if (parent !== null) {
    return fixed.length > 0 ? [node, ...fixed] : [node];
  }

  // ── Root (body) → always recurse ─────────────────────────────────────────
  return getChildren(node).flatMap((c) => findSections(c, node));
}

function hasFloaterDesc(node) {
  for (const c of getChildren(node)) {
    if (isFloater(c)) return true;
    if (hasFloaterDesc(c)) return true;
  }
  return false;
}

function isVerticalContainer(node) {
  const kids = getChildren(node).filter((c) => !isOffscreen(c));
  const inFlow = kids.filter((c) => isInFlow(c));
  const absKids = kids.filter((c) => c.position == "absolute");

  if (inFlow.length < 2 || inFlow.length >= 7) return false;

  if (absKids.length > 0) {
    const allBoxedKids = kids.filter((c) => hasBox(c) && !isFloater(c));
    for (const abs of absKids) {
      const absTop = getAbsoluteTop(abs);
      const absBottom = absTop + getHeight(abs);
      for (const sibling of allBoxedKids) {
        if (sibling === abs) continue;
        const sibTop = getAbsoluteTop(sibling);
        const sibBottom = sibTop + getHeight(sibling);
        const overlap = Math.min(absBottom, sibBottom) - Math.max(absTop, sibTop);
        if (overlap > 0) return false;
      }
    }
  }
  // // check whether it is vertical stacking
  // const sorted = [...inFlow].sort((a, b) => getAbsoluteTop(a) - getAbsoluteTop(b));
  // let totalOverlap = 0;
  // for (let i = 1; i < sorted.length; i++) {
  //   const prev = sorted[i - 1];
  //   const curr = sorted[i];
  //   const prevBottom = getAbsoluteTop(prev) + getHeight(prev);
  //   const overlap = Math.max(0, prevBottom - getAbsoluteTop(curr));
  //   totalOverlap += overlap / Math.max(getHeight(prev), 1);
  // }

  // return totalOverlap / (sorted.length - 1) < 0.15;
  for (let i = 0; i < inFlow.length; i++) {
    for (let j = i + 1; j < inFlow.length; j++) {
      const a = inFlow[i];
      const b = inFlow[j];
      const aLeft = a.geometry?.left ?? 0;
      const aRight = aLeft + (a.geometry?.width ?? 0);
      const bLeft = b.geometry?.left ?? 0;
      const bRight = bLeft + (b.geometry?.width ?? 0);
      const horizOverlap = Math.min(aRight, bRight) - Math.max(aLeft, bLeft);
      if (horizOverlap <= 0) return false; // side by side → not vertical
    }
  }

  return true;
}

function fallbackSectionMatch(liveSections, stagingSections) {
  const liveCandidatesLength = liveSections.length;
  const stagingCandidatesLength = stagingSections.length;
  const threshold = 40;

  const pairs = [];
  for (let li = 0; li < liveCandidatesLength; li++) {
    for (let si = 0; si < stagingCandidatesLength; si++) {
      const matchScore = scoreMatch(liveSections[li], stagingSections[si], liveCandidatesLength, li, stagingCandidatesLength, si);
      if (matchScore > threshold) pairs.push({ liveIndex: li, stagingIndex: si, score: matchScore });
    }
  }
  pairs.sort((a, b) => b.score - a.score);

  const usedLive = new Set();
  const usedStaging = new Set();
  const matches = [];

  for (const { liveIndex, stagingIndex, score } of pairs) {
    if (usedLive.has(liveIndex) || usedStaging.has(stagingIndex)) continue;
    usedLive.add(liveIndex);
    usedStaging.add(stagingIndex);
    matches.push({
      live: liveSections[liveIndex],
      staging: stagingSections[stagingIndex],
      liveOrder: liveIndex,
      stagingOrder: stagingIndex,
      score,
    });
  }

  // Unmatched live-only
  for (let li = 0; li < liveCandidatesLength; li++) {
    if (usedLive.has(li)) continue;
    matches.push({
      live: liveSections[li],
      staging: null,
      liveOrder: li,
      stagingOrder: Infinity,
      score: 0,
    });
  }

  // Unmatched staging-only
  for (let si = 0; si < stagingCandidatesLength; si++) {
    if (usedStaging.has(si)) continue;
    matches.push({
      live: null,
      staging: stagingSections[si],
      liveOrder: Infinity,
      stagingOrder: si,
      score: 0,
    });
  }

  return matches;
}

function scoreMatch(liveEle, stagingEle, liveCandidatesLength, liveIndex, stagingCandidatesLength, stagingIndex) {
  let score = 0;

  //has same stable Id
  const liveId = liveEle.id && !autoID.test(liveEle.id) ? liveEle.id : null;
  const stagingId = stagingEle.id && !autoID.test(stagingEle.id) ? stagingEle.id : null;
  if (liveId && stagingId && liveId === stagingId) score += 40;

  //has same data attribute
  const liveDataset = liveEle.dataset;
  const stagingDataset = stagingEle.dataset;
  const liveData = liveDataset.testid || liveDataset["section-id"] || liveDataset.section || liveDataset.name || null;
  const stagingData = stagingDataset.testid || stagingDataset["section-id"] || stagingDataset.section || stagingDataset.name || null;
  if (liveData && stagingData && liveData === stagingData) score += 30;

  //has text similarity
  const textSim = isTextSimilar(liveEle.textPreview, stagingEle.textPreview);
  if (textSim === 1) score += 30;
  else if (textSim >= 0.7) score += 15;
  else if (textSim >= 0.4) score += 5;

  //has same geometry
  const pageHeight = Math.max(
    liveEle.geometry?.ratioOfPage > 0 ? getHeight(liveEle) / liveEle.geometry.ratioOfPage : 0,
    stagingEle.geometry?.ratioOfPage > 0 ? getHeight(stagingEle) / stagingEle.geometry.ratioOfPage : 0,
  );
  const topDiff = Math.abs(getAbsoluteTop(liveEle) - getAbsoluteTop(stagingEle)) / pageHeight;
  const heightDiff = Math.abs(getHeight(liveEle) - getHeight(stagingEle)) / Math.max(getHeight(liveEle), getHeight(stagingEle), 1);
  score += Math.max(0, 1 - topDiff / 0.05) * 12;
  score += Math.max(0, 1 - heightDiff / 0.2) * 8;

  //has same Tag + stable class overlap
  if (liveEle.tag === stagingEle.tag) score += 3;
  const liveClass = stableClass(liveEle.class);
  const stagingClassSet = new Set(stableClass(stagingEle.class));
  if (liveClass[0] && stagingClassSet.has(liveClass[0])) score += 7;
  if (liveClass[1] && stagingClassSet.has(liveClass[1])) score += 3;
  if (score < 13 && liveClass.some((c) => stagingClassSet.has(c))) score += 2;

  //has same Relative order
  const lRel = liveIndex / Math.max(liveCandidatesLength - 1, 1);
  const sRel = stagingIndex / Math.max(stagingCandidatesLength - 1, 1);
  score += Math.max(0, 1 - Math.abs(lRel - sRel) / 0.5) * 10;

  return score;
}

function getAbsoluteTop(node) {
  return node.geometry?.documentTop ?? 0;
}

function isFloater(node) {
  return node.position == "fixed" || node.position == "sticky" || node.isScrollable;
}

function isUtility(cls) {
  if (utilityWords.has(cls.toLowerCase())) return true;
  if (utilitySelectors.test(cls)) return true;
  return false;
}

function stableClass(classStr) {
  const classList = (classStr || "").split(/\s+/).filter(Boolean);
  return classList.filter((cls) => !isUtility(cls));
}

function isTextSimilar(liveText, stagingText) {
  if (!liveText || !stagingText) return 0;

  const wordsA = new Set(
    liveText
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length >= 3),
  );
  const wordsB = new Set(
    stagingText
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length >= 3),
  );

  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  const shared = [...wordsB].filter((w) => wordsA.has(w)).length;
  return shared / Math.max(wordsA.size, wordsB.size);
}

function isStructurallySimilar(liveNode, stagingNode) {
  //tag check
  const sameTag = liveNode.tag === stagingNode.tag;

  //class check
  const liveClasses = stableClass(liveNode.class);
  const stagingClasses = new Set(stableClass(stagingNode.class));
  const classMatch = liveClasses.every((cls) => stagingClasses.has(cls));

  //text similarity
  const textisSimilar = isTextSimilar(liveNode.textPreview, stagingNode.textPreview);

  return (sameTag && classMatch) || textisSimilar >= 0.7;
}

function getChildren(node) {
  return (node.children || []).filter((node) => node && !Array.isArray(node) && typeof node === "object");
}

function isOffscreen(node) {
  // console.log("node class list",node.class)
  if (node.class && node.class.split(/\s+/).filter(Boolean).includes("sr-only")) return true;
  if ((node.geometry?.documentTop ?? 0) < 0) return true;
  return false;
}

function isInFlow(node) {
  return node.position == "static" || node.position == "relative";
}

function hasBox(node) {
  const geometry = node.geometry;
  return geometry.width > 0 && geometry.height > 0;
}

function hasanyBox(node) {
  if (hasBox(node)) return true;
  for (const child of getChildren(node)) if (hasanyBox(child)) return true;
  return false;
}

function getHeight(node) {
  const geometry = node.geometry;
  return geometry.height;
}

function normalizeName(raw) {
  const STRIP = /[\s_-]*(parent|container|wrapper|section|inner|outer|wrap|holder|box)$/gi;
  return raw
    .replace(/[_-]+/g, " ")
    .replace(STRIP, "")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function generateSectionName(node) {
  const d = node.dataset || {};
  if (d.section) return normalizeName(d.section);
  if (d.name) return normalizeName(d.name);

  // const aria = node.ariaLabel || node["aria-label"];
  // if (aria && aria.split(/\s+/).length <= 6) return normalizeName(aria);

  // Use textContent (the heading text we extracted) — most readable name
  if (node.textContent && node.textContent.split(/\s+/).length <= 8) return normalizeName(node.textContent);

  if (node.id && !autoID.test(node.id)) return normalizeName(node.id);

  const sc = stableClass(node.class);
  if (sc.length > 0) return normalizeName(sc[0]);

  const SEMANTIC = {
    header: "Header",
    footer: "Footer",
    nav: "Navigation",
    main: "Main",
    aside: "Sidebar",
    article: "Article",
    section: "Section",
  };
  if (SEMANTIC[node.tag]) return SEMANTIC[node.tag];

  return null;
}

function getCaptureType(node) {
  if (node.isScrollable) return "inner-scroll";
  const p = node.position;
  if (p === "fixed") return "fixed";
  if (p === "sticky") return "sticky";
  return "normal";
}
// =============================================================================
// section extractor main
// =============================================================================

//primary approach walk both trees parallely to extract the section
function walkBothTrees(liveNode, stagingNode, liveNodeParent = null, stagingNodeParent = null) {
  if (isFloater(liveNode) && isFloater(stagingNode)) {
    return [{ live: liveNode, staging: stagingNode, liveOrder: 0, stagingOrder: 0 }];
  }

  //check the structural similaritry to decide walk further os fallback
  if (!isStructurallySimilar(liveNode, stagingNode)) {
    //if diverged fallback to extract sections from subtree
    const liveSections = findSections(liveNode, liveNodeParent);
    const stagingSections = findSections(stagingNode, stagingNodeParent);
    return fallbackSectionMatch(liveSections, stagingSections);
  }

  const liveCurrentNodeChildren = getChildren(liveNode).filter((child) => !isOffscreen(child));
  const stagingCurrentNodeChildren = getChildren(stagingNode).filter((child) => !isOffscreen(child));

  const liveCurrentNodeInFlowElements = liveCurrentNodeChildren.filter((child) => isInFlow(child));
  const stagingCurrentNodeInFlowElements = stagingCurrentNodeChildren.filter((child) => isInFlow(child));

  const liveCurrentNodeFloaterElements = liveCurrentNodeChildren.filter((child) => isFloater(child));
  const stagingCurrentNodeFloaterElements = stagingCurrentNodeChildren.filter((child) => isFloater(child));

  const isLiveaWrapper =
    liveCurrentNodeInFlowElements.length == 1 &&
    hasBox(liveCurrentNodeInFlowElements[0]) &&
    getHeight(liveCurrentNodeInFlowElements[0]) / getHeight(liveNode) > 0.9 &&
    liveNode.geometry?.ratioOfViewport > 1.1;

  const isStagingaWrapper =
    stagingCurrentNodeInFlowElements.length == 1 &&
    hasBox(stagingCurrentNodeInFlowElements[0]) &&
    getHeight(stagingCurrentNodeInFlowElements[0]) / getHeight(stagingNode) > 0.9 &&
    stagingNode.geometry?.ratioOfViewport > 1.1;

  if (isLiveaWrapper && isStagingaWrapper) {
    const floaterMatches = fallbackSectionMatch(liveCurrentNodeFloaterElements, stagingCurrentNodeFloaterElements);

    //recurse into the big wrapper to extract teh real sections
    const childMatches = walkBothTrees(liveCurrentNodeInFlowElements[0], stagingCurrentNodeInFlowElements[0], liveNode, stagingNode);

    return [...floaterMatches, ...childMatches];
  }

  //if one side is a wrapper but other side is not- diverges
  if (isLiveaWrapper !== isStagingaWrapper) {
    const liveSections = findSections(liveNode, liveNodeParent);
    const stagingSections = findSections(stagingNode, stagingNodeParent);
    return fallbackSectionMatch(liveSections, stagingSections);
  }

  //both sections fit in viewport extract as section
  const liveNodeRatio = liveNode.geometry?.ratioOfViewport ?? 0;
  const stagingNodeRatio = stagingNode.geometry?.ratioOfViewport ?? 0;

  if (
    liveNodeRatio > 0 &&
    liveNodeRatio <= 1.3 &&
    stagingNodeRatio > 0 &&
    stagingNodeRatio <= 1.3 &&
    !isVerticalContainer(liveNode) &&
    !isVerticalContainer(stagingNode)
  ) {
    return [
      {
        live: liveNode,
        staging: stagingNode,
        liveOrder: 0,
        stagingOrder: 0,
        score: 80,
      },
    ];
  }

  //if vertical container with valid children to recurse into
  else if (isVerticalContainer(liveNode) || isVerticalContainer(stagingNode)) {
    const liveKids = getChildren(liveNode).filter((c) => !isOffscreen(c) && (hasBox(c) || hasanyBox(c)));
    const stagingKids = getChildren(stagingNode).filter((c) => !isOffscreen(c) && (hasBox(c) || hasanyBox(c)));

    if (liveKids.length === stagingKids.length) {
      const allSimilar = liveKids.every((lk, i) => isStructurallySimilar(lk, stagingKids[i]));

      if (allSimilar) {
        // Every pair agrees → safe to walk together index by index
        const results = [];
        for (let i = 0; i < liveKids.length; i++) {
          results.push(...walkBothTrees(liveKids[i], stagingKids[i], liveNode, stagingNode));
        }
        return results;
      }
    }
    // At least one pair does not match → fall back to scorer on these subtrees. We collect all section candidates independently from each side and fallbackMatch pair them by geometry + text + class signals.
    const lc = findSections(liveNode, liveNodeParent);
    const sc = findSections(stagingNode, stagingNodeParent);
    return fallbackSectionMatch(lc, sc);
  }

  //fallback if anything else happened
  const lc = findSections(liveNode, liveNodeParent);
  const sc = findSections(stagingNode, stagingNodeParent);
  return fallbackSectionMatch(lc, sc);
}

export function extractSectionsFromDOMTree(
  liveTree,
  stagingTree,
  pageName = "trial page",
  path = "/",
  scrollIsWindow = true,
  scrollRoot = null,
) {
  const rawMatches = walkBothTrees(liveTree, stagingTree);

  // Re-index orders after the walk so sort is stable
  const liveMatches = rawMatches
    .filter((m) => m.live !== null)
    .sort((a, b) => a.liveOrder - b.liveOrder)
    .map((m, i) => ({ ...m, liveOrder: i }));

  const stagingMatches = rawMatches
    .filter((m) => m.staging !== null)
    .sort((a, b) => a.stagingOrder - b.stagingOrder)
    .map((m, i) => ({ ...m, stagingOrder: i }));

  let liveN = 1;
  const liveSections = liveMatches.map((m) => {
    const name = generateSectionName(m.live) || `Section ${liveN++}`;
    const ct = getCaptureType(m.live);
    return {
      section: name,
      selector: m.live.selector,
      state: [],
      captureType: ct,
      floating: ct === "fixed" || ct === "sticky",
    };
  });

  let stagingN = 1;
  const stagingSections = stagingMatches.map((m) => {
    const nameNode = m.live || m.staging;
    const name = generateSectionName(nameNode) || `Section ${stagingN++}`;
    const ct = getCaptureType(m.staging);
    return {
      section: name,
      selector: m.staging.selector,
      state: [],
      captureType: ct,
      floating: ct === "fixed" || ct === "sticky",
    };
  });

  const base = { page: pageName, path, scrollIsWindow, scrollRoot };
  return {
    live: { ...base, sections: liveSections },
    staging: { ...base, sections: stagingSections },
  };
}
