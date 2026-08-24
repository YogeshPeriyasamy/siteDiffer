export async function fixStickyAndFixed(page) {
  // function to neutralize sticky and fixed elements by setting their position to static and resetting related properties
  await page.evaluate(() => {
    if (window.__stickyNeutralizerInstalled) return;
    window.__stickyNeutralizerInstalled = true;

    function neutralize() {
      document.querySelectorAll("*").forEach((el) => {
        const style = getComputedStyle(el);

        if (style.position === "fixed" || style.position === "sticky") {
          el.style.setProperty("position", "static", "important");
          el.style.setProperty("top", "auto", "important");
          el.style.setProperty("right", "auto", "important");
          el.style.setProperty("bottom", "auto", "important");
          el.style.setProperty("left", "auto", "important");
          el.style.setProperty("z-index", "auto", "important");
          el.style.setProperty("transform", "none", "important");
          el.style.setProperty("display", "block", "important");
        }
      });
    }

    // Apply immediately
    neutralize();

    // Reapply when DOM changes
    const observer = new MutationObserver(neutralize);
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["class", "style"],
    });

    // Reapply on scroll
    window.addEventListener("scroll", neutralize, true);

    // Reapply periodically
    const interval = setInterval(neutralize, 200);

    // Store handles for cleanup if needed
    window.__stickyNeutralizer = {
      observer,
      interval,
      neutralize,
    };
  });
}
