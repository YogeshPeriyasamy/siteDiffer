import { waitFor } from "./helper.js";
/**
 * overflow:hidden — scroll window so section is in view, capture visible area.
 * Returns a raw buffer (caller normalizes to exact size).
 */
export async function captureVisibleOnly(page, { x, y, width, height }, VW, VH, windowScrollWorks) {
  if (windowScrollWorks) {
    const scrollTo = Math.max(0, y - Math.floor((VH - height) / 2));
    await page.evaluate((scrollToPoint) => window.scrollTo(0, scrollToPoint), scrollTo);
    await waitFor(page,80);
  }

  const scrollY = await page.evaluate(() => window.scrollY);
  const clipY = Math.max(0, Math.min(y - scrollY, VH - 1));
  const clipH = Math.min(height, VH - clipY);
  const clipX = Math.max(0, Math.min(x, VW - 1));
  const clipW = Math.min(width, VW - clipX);

  if (clipW < 1 || clipH < 1) throw new Error("visible region is zero-size");

  return page.screenshot({
    clip: { x: clipX, y: clipY, width: clipW, height: clipH },
    fullPage: false,
  });
}
