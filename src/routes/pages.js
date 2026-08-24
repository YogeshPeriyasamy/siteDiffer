import { Router } from "express";

import { resolveSiteKeyFromHostname, getPagesForSite } from "../services/siteService.js";

const router = Router();

// ---------------------------------------------------------------------------
// GET /pages
//
// Accepts ?liveUrl=...&stagingUrl=... (query params).
// Resolves the site from the live hostname, validates that staging matches the
// same site entry, and returns the list of available pages.
//
// Response 200:  { siteKey: string, pages: [{ id, label, path }] }
// Response 400:  { message: string }
// ---------------------------------------------------------------------------
router.get("/pages", (req, res) => {
  const { liveUrl, stagingUrl } = req.query;

  if (!liveUrl || !stagingUrl) {
    return res.status(400).json({ message: "liveUrl and stagingUrl are required" });
  }

  let liveHost, stagingHost;
  try {
    liveHost    = new URL(liveUrl).hostname.replace(/^www\./, "");
    stagingHost = new URL(stagingUrl).hostname.replace(/^www\./, "");
  } catch {
    return res.status(400).json({ message: "Invalid URL format" });
  }

  const liveSiteKey    = resolveSiteKeyFromHostname(liveHost);
  const stagingSiteKey = resolveSiteKeyFromHostname(stagingHost);

  if (!liveSiteKey) {
    return res.status(400).json({
      message: `No site configuration found for "${liveHost}". Check the live URL.`,
    });
  }

  if (!stagingSiteKey) {
    return res.status(400).json({
      message: `No site configuration found for "${stagingHost}". Check the staging URL.`,
    });
  }

  if (liveSiteKey !== stagingSiteKey) {
    return res.status(400).json({
      message: `URLs appear to be for different sites ("${liveSiteKey}" vs "${stagingSiteKey}"). Both URLs must belong to the same site.`,
    });
  }

  const pages = getPagesForSite(liveSiteKey);
  return res.json({ siteKey: liveSiteKey, pages });
});

export default router;
