import { siteData } from "../../../data.js";

// ---------------------------------------------------------------------------
// it returns
// Returns { live: ExtractionMap, staging: ExtractionMap }
//
// ExtractionMap = { [pageName]: ExtractionResult }
// ExtractionResult = {
//   url, page, scrollRootSelector, scrollRootIsWindow,
//   page geometry placeholder, sections: SectionDescriptor[]
// }
// ---------------------------------------------------------------------------

export default async function manifestSections(siteName, pages, liveBaseUrl, stagingBaseUrl) {
  const normalizedSiteName = resolveSiteKey(siteName);
  const siteEntry = siteData[normalizedSiteName];
  if (!siteEntry) throw new Error(`[manifestSections] Unknown site: "${siteName}"`);

  // live and staging have their own separate page/section definitions
  const live    = buildEnvMap(siteEntry.live?.pages    ?? [], pages, liveBaseUrl);
  const staging = buildEnvMap(siteEntry.staging?.pages ?? [], pages, stagingBaseUrl);

  return { live, staging };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Builds { [pageName]: ExtractionResult } using the supplied baseUrl.
 */
function buildEnvMap(pageList, requestedPages, baseUrl) {
  if (!pageList?.length) return {};

  const result = {};

  for (const pageObj of pageList) {
    if (!requestedPages.includes(pageObj.page)) continue;
    result[pageObj.page] = buildExtractionResult(pageObj, baseUrl);
  }

  return result;
}

/**
 * Converts a page definition + dynamic baseUrl into an ExtractionResult that
 * sectionCapturer.captureSections() can consume.
 */
function buildExtractionResult(pageObj, baseUrl) {
  const sections = [];

  for (const sectionDef of pageObj.sections ?? []) {
    const expanded = expandSectionStates(sectionDef);
    sections.push(...expanded);
  }

  const url = buildPageUrl(baseUrl, pageObj.path);

  return {
    url,
    page:               pageObj.page,
    scrollRootSelector: pageObj.scrollRoot ?? null,
    scrollRootIsWindow: pageObj.scrollIsWindow ?? true,
    // geometry is resolved at runtime by the browser
    pageInfo: { width: 0, height: 0, maxScrollY: 0 },
    sections,
  };
}

/**
 * Expands one dataset section into one or more SectionDescriptors, one per state.
 */
function expandSectionStates(sectionDef) {
  const {
    section: sectionName,
    selector,
    state = [],
    captureType = "normal",
    floating = false,
  } = sectionDef;

  if (!state || state.length === 0) {
    return [buildSectionDescriptor(sectionName, selector, null, null, captureType, floating)];
  }

  return state.map((stateConfig, index) =>
    buildSectionDescriptor(`${sectionName}State${index}`, selector, stateConfig, index, captureType, floating),
  );
}

/**
 * Creates a SectionDescriptor with geometry sentinel values (filled by capturer at runtime).
 */
function buildSectionDescriptor(key, selector, stateConfig, stateIndex, captureType = "normal", floating = false) {
  return {
    key,
    selector,
    stateConfig,
    stateIndex,
    captureType,
    floating,
    x: 0, y: 0, width: 0, height: 0,
    viewportX: 0, viewportY: 0, viewportRect: null,
    sampleScrollY: 0,
    discovery: "dataset",
  };
}

// ---------------------------------------------------------------------------
// Exported helper — used by the /pages endpoint in server.js
// ---------------------------------------------------------------------------


export function resolveSiteKeyFromHostname(hostname) {
  if (!hostname) return null;

  const h = hostname.toLowerCase().replace(/^www\./, "");

  // 1. exact
  if (siteData[hostname]) return hostname;

  // 2 & 3 & 4
  for (const key of Object.keys(siteData)) {
    const k = key.toLowerCase();
    if (k === h) return key;
    if (h.includes(k)) return key;
    if (k.includes(h)) return key;
  }

  return null;
}

/**
 * Returns the page list for a site key as [{ id, label, path }].
 *
 * Uses live pages as the source of truth for the list. If a page only exists
 * in staging it is also included. Pages are deduped by id so the user sees
 * each page once regardless of per-env differences.
 */
export function getPagesForSite(siteKey) {
  const entry = siteData[siteKey];
  if (!entry) return null;

  const seen = new Map();

  // Walk live first, then staging — live takes precedence for label/path
  for (const envKey of ["live", "staging"]) {
    for (const p of entry[envKey]?.pages ?? []) {
      if (!seen.has(p.page)) {
        seen.set(p.page, {
          id:    p.page,
          label: p.page
            .replace(/_/g, " ")
            .replace(/\b\w/g, (c) => c.toUpperCase()),
          path: p.path,
        });
      }
    }
  }

  return [...seen.values()];
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function resolveSiteKey(siteName) {
  if (!siteName || typeof siteName !== "string") return siteName;
  if (siteData[siteName]) return siteName;

  const normalized = siteName.trim();
  const match = Object.keys(siteData).find(
    (key) => key.toLowerCase() === normalized.toLowerCase(),
  );
  return match ?? normalized;
}

function buildPageUrl(baseUrl, pathValue) {
  if (!baseUrl) return pathValue ?? "/";

  // Normalise the user-supplied base to just the origin (protocol + host + port).
  // This means if the user pastes a full page URL like
  //   https://knowesr1.com/index.html
  // we still build correct paths instead of appending onto a file URL.
  let origin;
  try {
    const parsed = new URL(baseUrl);
    // Use just protocol + hostname + port — discard any path/query/hash the
    // user may have included in the base URL field.
    origin = parsed.origin; // e.g. "https://knowesr1.com"
  } catch {
    // URL constructor not available in this context (shouldn't happen in Node),
    // fall back to simple trailing-slash strip.
    origin = String(baseUrl).replace(/\/+$/, "");
  }

  // Ensure path starts with exactly one slash.
  const p = pathValue
    ? "/" + String(pathValue).replace(/^\/+/, "")
    : "/";

  return `${origin}${p}`;
}
