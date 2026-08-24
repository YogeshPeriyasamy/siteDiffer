export function fontSignal(config) {
  const { timeoutMs } = config;

  return {
    name: "fontsLoader",
    timeout: timeoutMs,
    failSafe: false,
    run: (page) =>
      page.waitForFunction(
        () => document.fonts && document.fonts.status === "loaded",
        null,
        { timeout: timeoutMs },
      ),
  };
}
