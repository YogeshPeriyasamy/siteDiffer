export function imgSignal(config) {
  const { timeoutMs } = config;

  return {
    name: "imagesLoader",
    timeout: timeoutMs,
    failSafe: false,
    run: (page) =>
      page.waitForFunction(
        () => {
          const imgs = document.getElementsByTagName("img");
          return Array.from(imgs).every(
            (img) => img.complete && img.naturalWidth > 0,
          );
        },
        null,
        { timeout: timeoutMs },
      ),
  };
}
