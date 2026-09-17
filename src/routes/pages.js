import { Router } from "express";

import { resolveSiteKeyFromUrl, getPagesForSite, validateURL,mapPages } from "../services/siteService.js";
import { getBrowser } from "../capture/browser.js";

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
router.get("/pages", async (req, res) => {
  const { liveUrl, stagingUrl } = req.query;

  if (!liveUrl || !stagingUrl) {
    return res.status(400).json({ message: "Please provide valid live and staging URLs" });
  }

   const browser = await getBrowser();

   const liveSitepages = await getPagesForSite(liveUrl, browser);
   const stagingSitepages = await getPagesForSite(stagingUrl, browser);

  //  console.log("Live Site Pages:", liveSitepages);
  //  console.log("Staging Site Pages:", stagingSitepages);
  const pages = mapPages(liveSitepages, stagingSitepages);
  // console.log("Mapped Pages:", pages);

   res.status(200).json({ pages });

  //check the urls provided are valid and reachable

  // const [liveIsValid, stagingIsValid] = await Promise.all([validateURL(liveUrl), validateURL(stagingUrl)]);

  // if (!liveIsValid && !stagingIsValid) {
  //   return res.status(400).json({ message: "Provided live and staging URLs are not reachable" });
  // }
  // if (!liveIsValid) {
  //   return res.status(400).json({ message: "Provided live URL is not reachable" });
  // }
  // if (!stagingIsValid) {
  //   return res.status(400).json({ message: "Provided staging URL is not reachable" });
  // }

  // let liveHost, stagingHost;
  // try {
  //   liveHost = new URL(liveUrl).hostname.replace(/^www\./, "");
  //   stagingHost = new URL(stagingUrl).hostname.replace(/^www\./, "");
  // } catch {
  //   return res.status(400).json({ message: "Invalid URL format" });
  // }
  
  // const liveSiteKey = resolveSiteKeyFromUrl(liveUrl);
  // const stagingSiteKey = resolveSiteKeyFromUrl(stagingUrl);

  // if (!liveSiteKey) {
  //   return res.status(400).json({
  //     message: `No site configuration found for "${liveHost}". Check the live URL.`,
  //   });
  // }

  // if (!stagingSiteKey) {
  //   return res.status(400).json({
  //     message: `No site configuration found for "${stagingHost}". Check the staging URL.`,
  //   });
  // }

  // if (liveSiteKey !== stagingSiteKey) {
  //   return res.status(400).json({
  //     message: `URLs appear to be for different sites ("${liveSiteKey}" vs "${stagingSiteKey}"). Both URLs must belong to the same site.`,
  //   });
  // }

  // const pages = getPagesForSite(liveSiteKey);
  // return res.json({ siteKey: liveSiteKey, pages });
});

export default router;
