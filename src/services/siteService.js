import { siteData } from "../data/sites.js";

// ---------------------------------------------------------------------------
// manifestSections
//
// Builds ExtractionMaps for live and staging from the site manifest + base URLs.
//
// Returns { live: ExtractionMap, staging: ExtractionMap }
//
// ExtractionMap = { [pageName]: ExtractionResult }
// ExtractionResult = {
//   url, page, scrollRootSelector, scrollRootIsWindow,
//   pageInfo (geometry placeholder), sections: SectionDescriptor[]
// }
// ---------------------------------------------------------------------------
export default async function manifestSections(siteName, pages, liveBaseUrl, stagingBaseUrl) {
  const normalizedSiteName = resolveSiteKey(siteName);
  const siteEntry = siteData[normalizedSiteName];
  if (!siteEntry) throw new Error(`[manifestSections] Unknown site: "${siteName}"`);

  const live = buildEnvMap(siteEntry.live?.pages ?? [], pages, liveBaseUrl);
  const staging = buildEnvMap(siteEntry.staging?.pages ?? [], pages, stagingBaseUrl);

  return { live, staging };
}

// ---------------------------------------------------------------------------
// buildEnvMap — builds { [pageName]: ExtractionResult } using the supplied baseUrl
// ---------------------------------------------------------------------------
function buildEnvMap(pageList, requestedPages, baseUrl) {
  if (!pageList?.length) return {};

  const result = {};

  for (const pageObj of pageList) {
    if (!requestedPages.includes(pageObj.page)) continue;
    result[pageObj.page] = buildExtractionResult(pageObj, baseUrl);
  }

  return result;
}

// ---------------------------------------------------------------------------
// buildExtractionResult
//
// Converts a page definition + dynamic baseUrl into an ExtractionResult that
// sectionCapturer.captureSections() can consume.
// ---------------------------------------------------------------------------
function buildExtractionResult(pageObj, baseUrl) {
  const sections = [];

  for (const sectionDef of pageObj.sections ?? []) {
    const expanded = expandSectionStates(sectionDef);
    sections.push(...expanded);
  }

  const url = buildPageUrl(baseUrl, pageObj.path);

  return {
    url,
    page: pageObj.page,
    scrollRootSelector: pageObj.scrollRoot ?? null,
    scrollRootIsWindow: pageObj.scrollIsWindow ?? true,
    pageInfo: { width: 0, height: 0, maxScrollY: 0 },
    sections,
  };
}

// ---------------------------------------------------------------------------
// expandSectionStates
//
// Expands one dataset section into one or more SectionDescriptors, one per state.
// ---------------------------------------------------------------------------
function expandSectionStates(sectionDef) {
  const { section: sectionName, selector, state = [], captureType = "normal", floating = false } = sectionDef;

  if (!state || state.length === 0) {
    return [buildSectionDescriptor(sectionName, selector, null, null, captureType, floating)];
  }

  return state.map((stateConfig, index) =>
    buildSectionDescriptor(`${sectionName}State${index}`, selector, stateConfig, index, captureType, floating),
  );
}

// ---------------------------------------------------------------------------
// buildSectionDescriptor
//
// Creates a SectionDescriptor with geometry sentinel values (filled by capturer at runtime).
// ---------------------------------------------------------------------------
function buildSectionDescriptor(key, selector, stateConfig, stateIndex, captureType = "normal", floating = false) {
  return {
    key,
    selector,
    stateConfig,
    stateIndex,
    captureType,
    floating,
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    viewportX: 0,
    viewportY: 0,
    viewportRect: null,
    sampleScrollY: 0,
    discovery: "dataset",
  };
}

// ---------------------------------------------------------------------------
// resolveSiteKeyFromHostname — used by the GET /pages route
// ---------------------------------------------------------------------------
export function resolveSiteKeyFromHostname(hostname) {
  if (!hostname) return null;

  const h = hostname.toLowerCase().replace(/^www\./, "");

  console.log("hostname derived from it", h);
  // 1. exact match
  if (siteData[hostname]) return hostname;

  // 2. lowercase exact / 3. substring both ways
  for (const key of Object.keys(siteData)) {
    const k = key.toLowerCase();
    if (k === h) return key;
    if (h.includes("hcp") && !k.includes("hcp")) {
      continue;
    }
    if (h.includes(k)) return key;
    if (k.includes(h)) return key;
  }

  return null;
}

// ---------------------------------------------------------------------------
// getPagesForSite
//
// Returns the page list for a site key as [{ id, label, path }].
// Uses live pages as the source of truth. If a page only exists in staging
// it is also included. Pages are deduped by id.
// ---------------------------------------------------------------------------
export function getPagesForSite(siteKey) {
  const entry = siteData[siteKey];
  if (!entry) return null;

  const seen = new Map();

  for (const envKey of ["live", "staging"]) {
    for (const p of entry[envKey]?.pages ?? []) {
      if (!seen.has(p.page)) {
        seen.set(p.page, {
          id: p.page,
          label: p.page.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
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
  const match = Object.keys(siteData).find((key) => key.toLowerCase() === normalized.toLowerCase());
  return match ?? normalized;
}

function buildPageUrl(baseUrl, pagePath) {
  return new URL(baseUrl).origin + pagePath;
}

export async function validateURL(url) {
  try {
    const response = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(5000) });
    return response.ok;
  } catch {
    return false;
  }
}
