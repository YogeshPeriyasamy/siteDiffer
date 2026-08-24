export function frameSignal(config) {
  const { stableFrames, maxWaitMs, threshold } = config;

  return {
    name: "frameStable",
    timeout: maxWaitMs,
    failSafe: false,
    run: (page) =>
      page.evaluate(
        ({ stableFrames, threshold }) => {
          return new Promise((resolve, reject) => {
            let stableCount = 0;
            let lastCheckTime = performance.now();

            const checkFrame = () => {
              const now = performance.now();

              if (now - lastCheckTime < threshold) {
                stableCount++;
              } else {
                stableCount = 0;
              }

              lastCheckTime = now;

              if (stableCount >= stableFrames) {
                resolve();
              } else {
                requestAnimationFrame(checkFrame);
              }
            };
            requestAnimationFrame(checkFrame);
          });
        },
        { stableFrames, threshold },
      ),
  };
}
