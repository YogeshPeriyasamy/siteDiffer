export async function domStabilitySignal(config) {
  const { quietMs, threshold, sampleWindow, pollIntervalMs, maxWaitMs } = config;

  return {
    name: "domStability",
    timeout: maxWaitMs,
    failSafe: false,
    run: (page) =>
      page.evaluate(
        ({ quietMs, threshold, sampleWindow, pollIntervalMs, maxWaitMs }) => {
          return new Promise((resolve, reject) => {
            let mutationCount = 0;
            let sampleMutations = [];
            let lastMutation = Date.now();

            const observer = new MutationObserver((mutations) => {
              lastMutation = Date.now();
              mutationCount += mutations.length;
            });

            observer.observe(document.documentElement, {
              childList: true,
              subtree: true,
              attributes: true,
              characterData: true,
            });

            const interval = setInterval(() => {
              sampleMutations.push(mutationCount);
              mutationCount = 0;

              if (sampleMutations.length > sampleWindow) sampleMutations.shift();

              const avg = sampleMutations.reduce((a, b) => a + b, 0) / sampleMutations.length;
              const now = Date.now();

              if (avg < threshold && now - lastMutation >= quietMs) {
                cleanUp();
                resolve();
              }
            }, pollIntervalMs);

            function cleanUp() {
              clearInterval(interval);
              observer.disconnect();
            }

            setTimeout(() => {
              cleanUp();
              reject(new Error("DOM stability timeout"));
            }, maxWaitMs);
          });
        },
        { quietMs, threshold, sampleWindow, pollIntervalMs, maxWaitMs },
      ),
  };
}
