//helper to ensure waits are consistent and easily adjustable in one place
export async function waitFor(page, ms) {
  return await page.waitForTimeout(ms);
}

/**
 * Classifies the scroll/overflow behaviour of a section by sampling the DOM
 * element at its centre and walking up the ancestor chain.
 *
 * Returns: "overflow-hidden" | "scrollable-container" | "normal"
 */
export async function classifySection(page, section) {
  return page.evaluate(
    ({ x, y, sectionWidth, sectionHeight }) => {
      const cx = x + sectionWidth / 2;
      const cy = y + sectionHeight / 2;
      const ele = document.elementFromPoint(cx - window.scrollX, cy - window.scrollY);
      if (!ele) return "normal";

      // node is the innermost element at the section's center point;
      // we walk up from there to check for scroll/overflow styles that affect the section
      let node = ele;
      while (node && node !== document.documentElement) {
        const style = getComputedStyle(node);
        const overflowY = style.overflowY;
        const overflowX = style.overflowX;

        if (overflowY === "hidden" || overflowX === "hidden") return "overflow-hidden";

        if (overflowY === "scroll" || overflowY === "auto") {
          //check if this is a truly scrollable container (with vertical overflow)
          // or just a full-width element with horizontal overflow (e.g. a horizontal slider or the page itself)
          const isVerticallyScrollable = node.scrollHeight > node.clientHeight + 2; // +2 is little tolerance for subpixel rendering differences that could make scrollHeight report a few pixels larger than clientHeight even when not truly scrollable
          // ignore full-width containers (page-level scroll or horizontal sliders)
          // only a narrower inner container qualifies as a true scrollable section

          const isNarrowEnough = node.clientWidth < window.innerWidth * 0.9;

          if (isVerticallyScrollable && isNarrowEnough) return "scrollable-container";

          // horizontal-only scroller or full-width container → treat as hidden
          // (capture only what is visible, no expansion)
          if (!isVerticallyScrollable && node.scrollWidth > node.clientWidth + 2) {
            return "overflow-hidden";
          }
        }

        node = node.parentElement;
      }
      return "normal";
    },
    { x: section.x, y: section.y, sectionWidth: section.width, sectionHeight: section.height },
  );
}

/**
 * Returns a unique CSS selector for the inner scrollable container
 * that lives inside the given section.
 */
export async function getScrollContainerSelector(page, section) {
  return page.evaluate(
    ({ x, y, width, height }) => {
      const cx = x + width / 2;
      const cy = y + height / 2;
      const el = document.elementFromPoint(cx - window.scrollX, cy - window.scrollY);
      if (!el) return null;

      let node = el;
      while (node && node !== document.documentElement) {
        const style = getComputedStyle(node);
        const overflowY = style.overflowY;
        if ((overflowY === "scroll" || overflowY === "auto") && node.scrollHeight > node.clientHeight + 2) {
          if (node.id) return `#${node.id}`;
          const cls = Array.from(node.classList).slice(0, 3).join(".");
          return cls ? `${node.tagName.toLowerCase()}.${cls}` : node.tagName.toLowerCase();
        }
        node = node.parentElement;
      }
      return null;
    },
    { x: section.x, y: section.y, width: section.width, height: section.height },
  );
}
