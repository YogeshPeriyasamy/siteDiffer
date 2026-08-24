export function loaderSignal(config) {
  const { timeoutMs, selectors = [] } = config;
  // console.log(" loader timeout", timeoutMs);

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
              if (isVisible(ele)) return false; //means still loading
            }
          }

          return true; // no visible loaders found

          function isVisible(ele) {
            const style = window.getComputedStyle(ele);
            if (
              style.display == "none" ||
              style.visibility == "hidden" ||
              style.opacity == 0
            ) {
              return false;
            }
            //getBoundingClientRect() is a DOM API method that returns the exact size and position of an element relative to the viewport.
            //  it returns  {x: number, y: number,width: number, height: number,top: number,right: number, bottom: number,left: number}
            const rect = ele.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
          }
        },
        { selectors },
        { timeout: timeoutMs },
      ),
  };
}
