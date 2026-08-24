export async function readyStateSignal(config) {
  const { timeoutMs } = config;

  return {
    name: "readyState",
    timeout: timeoutMs,
    failSafe: false,
    run: (page) =>
      page.waitForFunction(
        () => document.readyState === "complete",
        null,
        { timeout: timeoutMs },
      ),
  };
}
