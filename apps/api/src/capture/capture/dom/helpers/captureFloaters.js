export async function freezeCaptureState(page) {
  await page.evaluate(() => {
    document.documentElement.style.setProperty("scroll-behavior", "auto", "important");
    document.body.style.setProperty("scroll-behavior", "auto", "important");

    window.__captureMode = true;
  });
}

export async function revealElementForCapture(page, selector) {
  return page.evaluate((selector) => {
    const el = document.querySelector(selector);
    if (!el) return null;

    const rect = el.getBoundingClientRect();
    const docY = window.scrollY + rect.top;

    el.dataset.__captureOldStyle = el.getAttribute("style") || "";

    el.style.setProperty("display", "block", "important");
    el.style.setProperty("visibility", "visible", "important");
    el.style.setProperty("opacity", "1", "important");
    el.style.setProperty("position", "absolute", "important");
    el.style.setProperty("top", `${docY}px`, "important");
    el.style.setProperty("left", `${rect.left}px`, "important");
    el.style.setProperty("right", "auto", "important");
    el.style.setProperty("bottom", "auto", "important");
    el.style.setProperty("width", `${Math.max(rect.width, el.scrollWidth)}px`, "important");
    el.style.setProperty("height", `${el.scrollHeight}px`, "important");
    el.style.setProperty("max-height", "none", "important");
    el.style.setProperty("overflow", "visible", "important");
    el.style.setProperty("transform", "none", "important");
    el.style.setProperty("clip", "auto", "important");
    el.style.setProperty("clip-path", "none", "important");
    el.style.setProperty("z-index", "999999", "important");

    return {
      selector,
      x: Math.round(rect.left),
      y: Math.round(docY),
      width: Math.round(Math.max(rect.width, el.scrollWidth)),
      height: Math.round(el.scrollHeight),
      text: (el.innerText || "").trim().slice(0, 300),
    };
  }, selector);
}

export async function restoreElementAfterCapture(page, selector) {
  await page.evaluate((selector) => {
    const el = document.querySelector(selector);
    if (!el) return;

    const oldStyle = el.dataset.__captureOldStyle;

    if (oldStyle) el.setAttribute("style", oldStyle);
    else el.removeAttribute("style");

    delete el.dataset.__captureOldStyle;
  }, selector);
}

export async function hideElementsForNormalCapture(page, selectors) {
  await page.evaluate((selectors) => {
    for (const selector of selectors) {
      const el = document.querySelector(selector);
      if (!el) continue;

      el.dataset.__captureHideOldStyle = el.getAttribute("style") ?? "__NO_STYLE__";
      el.style.setProperty("visibility", "hidden", "important");
      el.style.setProperty("opacity", "0", "important");
      el.style.setProperty("pointer-events", "none", "important");
    }
  }, selectors);
}

export async function restoreElementsAfterNormalCapture(page, selectors) {
  await page.evaluate((selectors) => {
    for (const selector of selectors) {
      const el = document.querySelector(selector);
      if (!el) continue;

      const oldStyle = el.dataset.__captureHideOldStyle;

      if (oldStyle === "__NO_STYLE__") el.removeAttribute("style");
      else if (oldStyle != null) el.setAttribute("style", oldStyle);

      delete el.dataset.__captureHideOldStyle;
    }
  }, selectors);
}
export async function stageElementForCapture(page, selector) {
  return page.evaluate((selector) => {
    const oldStage = document.getElementById("__FLOAT_CAPTURE_STAGE__");
    if (oldStage) oldStage.remove();

    const source = document.querySelector(selector);
    if (!source) return null;

    const rect = source.getBoundingClientRect();

    const width = Math.ceil(
      Math.max(rect.width, source.scrollWidth, source.offsetWidth),
    );

    const clone = source.cloneNode(true);

    clone.style.setProperty("position", "static", "important");
    clone.style.setProperty("display", "block", "important");
    clone.style.setProperty("visibility", "visible", "important");
    clone.style.setProperty("opacity", "1", "important");
    clone.style.setProperty("width", `${width}px`, "important");
    clone.style.setProperty("height", "auto", "important");
    clone.style.setProperty("max-height", "none", "important");
    clone.style.setProperty("overflow", "visible", "important");
    clone.style.setProperty("transform", "none", "important");
    clone.style.setProperty("background", "#ffffff", "important");
    clone.style.setProperty("box-shadow", "none", "important");

    const stage = document.createElement("div");
    stage.id = "__FLOAT_CAPTURE_STAGE__";

    stage.style.setProperty("position", "absolute", "important");
    stage.style.setProperty("left", "0px", "important");
    stage.style.setProperty("top", "0px", "important");
    stage.style.setProperty("width", `${width}px`, "important");
    stage.style.setProperty("background", "#ffffff", "important");
    stage.style.setProperty("overflow", "hidden", "important");
    stage.style.setProperty("z-index", "2147483647", "important");

    stage.appendChild(clone);
    document.body.appendChild(stage);

    clone.querySelectorAll("*").forEach((child) => {
      const childStyle = getComputedStyle(child);

      if (childStyle.position === "fixed" || childStyle.position === "sticky") {
        child.style.setProperty("position", "static", "important");
      }

      if (child.scrollHeight > child.clientHeight) {
        child.style.setProperty("max-height", "none", "important");
        child.style.setProperty("overflow", "visible", "important");
        child.style.setProperty("height", `${child.scrollHeight}px`, "important");
      }
    });

    const height = Math.ceil(
      Math.max(clone.scrollHeight, clone.offsetHeight, stage.scrollHeight),
    );

    stage.style.setProperty("height", `${height}px`, "important");

    document.body.dataset.__floatCaptureOldMinHeight = document.body.style.minHeight || "";
    document.body.style.minHeight = `${Math.max(document.body.scrollHeight, height)}px`;

    return {
      selector,
      x: 0,
      y: 0,
      width,
      height,
      text: (source.innerText || "").trim().slice(0, 300),
    };
  }, selector);
}

export async function clearFloaterCaptureStage(page) {
  await page.evaluate(() => {
    const stage = document.getElementById("__FLOAT_CAPTURE_STAGE__");
    if (stage) stage.remove();

    const oldMinHeight = document.body.dataset.__floatCaptureOldMinHeight;
    if (oldMinHeight != null) {
      document.body.style.minHeight = oldMinHeight;
      delete document.body.dataset.__floatCaptureOldMinHeight;
    }
  });
}
