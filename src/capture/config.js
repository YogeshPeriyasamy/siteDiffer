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
};
