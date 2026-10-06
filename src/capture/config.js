export const captureConfig = {
  browser: "chromium",

  viewport: {
    width: 1440,
    height: 978,
  },

  deviceScaleFactor: 1,

  screenshot: {
    fullPage: true,
  },

  waitUntil: "load",

  timeout: 90000,

  maxSections: 80,

  minSectionRatio: 0.04, // 4% of the viewport height

  maxSectionRatio: 0.9, // 90% of the viewport height

  maxDepth: 6, // max depth for structural selector fallback

  // constants for fullpage capture
  OVERLAP_PX: 100, // each strip overlaps the previous by this many px

  SCROLL_SETTLE_MS: 160, // ms pause after each scroll before screenshot

  RAF_SETTLE_COUNT: 2, // wait this many animation frames after scroll

  STABLE_CHECKS: 3, // how many identical visual signatures = "stable"

  STABILITY_TIMEOUT: 1800, // max ms to wait for stability per strip

  MIN_WAIT_MS: 400, // minimum ms before declaring stable
};
