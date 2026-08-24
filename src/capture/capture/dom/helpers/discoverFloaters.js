export async function discoverFloatingSections(page) {
  return page.evaluate(() => {
    function selectorFor(el) {
      if (el.id) return `#${CSS.escape(el.id)}`;

      const parts = [];
      let node = el;
      while (node && node !== document.body && node !== document.documentElement && parts.length < 4) {
        let part = node.tagName.toLowerCase();
        const classes = Array.from(node.classList).filter(Boolean).slice(0, 2);
        if (classes.length) part += "." + classes.map((c) => CSS.escape(c)).join(".");
        const parent = node.parentElement;
        if (parent) {
          const siblings = Array.from(parent.children).filter((child) => child.tagName === node.tagName);
          if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
        }
        parts.unshift(part);
        node = node.parentElement;
      }
      return parts.join(" > ");
    }

    function score(el) {
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      if (style.display === "none" || style.visibility === "hidden" || parseFloat(style.opacity || "1") === 0) return 0;
      if (rect.width < 24 || rect.height < 12) return 0;
      if (rect.bottom <= 0 || rect.right <= 0 || rect.top >= window.innerHeight || rect.left >= window.innerWidth) return 0;

      const idCls = `${el.id || ""} ${el.className || ""}`.toLowerCase();
      const fixedish = style.position === "fixed" || style.position === "sticky";
      const highZ = Number.parseInt(style.zIndex, 10) > 20;
      const importantName = /header|nav|sticky|fixed|isi|safety|cookie|banner|floating|float|pdf|social|support/.test(idCls);
      const hasContent = (el.innerText || "").trim().length > 8 || el.querySelector("img,svg,button,a");

      let value = 0;
      if (fixedish) value += 70;
      if (highZ) value += 20;
      if (importantName) value += 25;
      if (hasContent) value += 10;
      if (rect.width > window.innerWidth * 0.35 || rect.height > 50) value += 10;
      return value;
    }

    const candidates = Array.from(document.querySelectorAll("*"))
      .map((el) => ({ el, score: score(el) }))
      .filter((item) => item.score >= 70)
      .sort((a, b) => b.score - a.score);

    const selected = [];
    for (const { el } of candidates) {
      const contained = selected.some((kept) => kept.contains(el) || el.contains(kept));
      if (!contained) selected.push(el);
    }

    return selected.map(selectorFor).filter(Boolean).slice(0, 20);
  });
}

