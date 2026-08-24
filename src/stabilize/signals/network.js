export function networkSignal(config) {
  const { quietWindowMs, maxWaitMs } = config;

  return {
    name: "networkStable",
    timeout: maxWaitMs,
    failSafe: false,
    run: (page) =>
      page.evaluate(
        ({ quietWindowMs, maxWaitMs }) => {
          return new Promise((resolve, reject) => {
            let lastActivity = performance.now();

            const observer = new PerformanceObserver(() => {
              lastActivity = performance.now();
            });

            observer.observe({ entryTypes: ["resource", "fetch"] });

            function check() {
              const now = performance.now();
              if (now - lastActivity > quietWindowMs) {
                observer.disconnect();
                resolve();
              } else {
                setTimeout(check, 200);
              }
            }

            check();

            setTimeout(() => {
              observer.disconnect();
              reject("timeout");
            }, maxWaitMs);
          });
        },
        { quietWindowMs, maxWaitMs },
      ),
  };
}
