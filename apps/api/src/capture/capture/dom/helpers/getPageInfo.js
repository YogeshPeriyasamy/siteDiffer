export async function getPageInfo(page) {
  return page.evaluate(() => {
    function findScroller(maxDepth = 5) {
      const candidates = [
        document.scrollingElement,
        document.documentElement,
        document.body,
        ...Array.from(document.querySelectorAll("*")),
      ].filter(Boolean);

      let best = document.scrollingElement || document.documentElement;
      let bestScore = 0;

      for (const el of candidates) {
        const style = getComputedStyle(el);

        const canScrollY =
          ["auto", "scroll"].includes(style.overflowY) ||
          el === document.scrollingElement ||
          el === document.documentElement ||
          el === document.body;

        if (!canScrollY) continue;

        const scrollableAmount = el.scrollHeight - el.clientHeight;
        if (scrollableAmount <= 20) continue;

        const rect = el.getBoundingClientRect();

        const visibleEnough =
          el === document.scrollingElement ||
          el === document.documentElement ||
          el === document.body ||
          (rect.width > window.innerWidth * 0.5 && rect.height > window.innerHeight * 0.5);

        if (!visibleEnough) continue;

        const score =
          scrollableAmount +
          Math.min(rect.width || window.innerWidth, window.innerWidth) +
          Math.min(rect.height || window.innerHeight, window.innerHeight);

        if (score > bestScore) {
          best = el;
          bestScore = score;
        }
      }

      return best;
    }

    function selectorFor(el) {
      if (el === document.scrollingElement || el === document.documentElement || el === document.body) {
        return null;
      }

      if (el.id) return `#${CSS.escape(el.id)}`;

      const parts = [];
      let node = el;

      while (node && node !== document.body && node !== document.documentElement && parts.length < 5) {
        let part = node.tagName.toLowerCase();

        const classes = Array.from(node.classList).slice(0, 2);
        if (classes.length) {
          part += "." + classes.map((c) => CSS.escape(c)).join(".");
        }

        const parent = node.parentElement;
        if (parent) {
          const sameTagSiblings = Array.from(parent.children).filter((child) => child.tagName === node.tagName);

          if (sameTagSiblings.length > 1) {
            part += `:nth-of-type(${sameTagSiblings.indexOf(node) + 1})`;
          }
        }

        parts.unshift(part);
        node = node.parentElement;
      }

      return parts.join(" > ");
    }

    const scrollingElement = findScroller(5);
    console.log("scrollingElement determined in page context:", scrollingElement);

    const scrollRootIsWindow =
      scrollingElement === document.scrollingElement || scrollingElement === document.documentElement || scrollingElement === document.body;

    const scrollRootSelector = scrollRootIsWindow ? null : selectorFor(scrollingElement);

    const height = Math.max(scrollingElement.scrollHeight, window.innerHeight);
    const width = Math.max(scrollingElement.scrollWidth, window.innerWidth);

    return {
      width,
      height,
      maxScrollY: Math.max(0, scrollingElement.scrollHeight - window.innerHeight),
      scrollRootSelector,
      scrollRootIsWindow,
    };
  });
}
