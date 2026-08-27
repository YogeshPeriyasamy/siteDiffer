export const defaultConfig = {
  scroll: {
    distance: 200,
    delay: 1000,
    interval: 300,
  },

  readyState: {
    timeoutMs: 20000,
  },

  dom: {
    quietMs: 1200,
    threshold: 2,
    sampleWindow: 5,
    pollIntervalMs: 200,
    maxWaitMs: 8000,
  },

  network: {
    quietWindowMs: 1000,
    maxWaitMs: 10000,
  },

  loaders: {
    timeoutMs: 25000,
    selectors: [
      ".loading",
      ".spinner",
      ".skeleton",
      '[data-loading="true"]',
      '[aria-busy="true"]',
      ".shimmer",
      ".progress",
    ],
  },

  images: {
    timeoutMs: 20000,
  },

  fonts: {
    timeoutMs: 10000,
  },

  frame: {
    stableFrames: 5,
    maxWaitMs: 3000,
    threshold: 50,
  },
};
