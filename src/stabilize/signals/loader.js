export function loaderSignal(config) {
  const { timeoutMs, selectors = [] } = config;

  return {
    name: "loaders",
    timeout: timeoutMs,
    failSafe: false,
    run: (page) =>
      page.waitForFunction(
        ({ selectors }) => {
          for (const sel of selectors) {
            const elements = document.querySelectorAll(sel);
            for (const ele of elements) {
              if (isVisible(ele)) return false;
            }
          }
          return true;

          function isVisible(ele) {
            const style = window.getComputedStyle(ele);
            if (style.display == "none" || style.visibility == "hidden" || style.opacity == 0) {
              return false;
            }
            const rect = ele.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
          }
        },
        { selectors },
        { timeout: timeoutMs },
      ),
  };
}
