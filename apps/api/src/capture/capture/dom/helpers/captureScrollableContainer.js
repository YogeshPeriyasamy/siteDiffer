import sharp from "sharp";

import { waitFor } from "./helper.js";

/**
 * scrollable-container — scrolls the inner element fully and stitches all strips.
 *
 * Returns fullBuffer whose height === container's full scrollHeight.
 * The caller is responsible for:
 *   - storing fullBuffer
 *   - cropping top section.height rows into buffer
 *   - computing expansion = fullBuffer.height - section.height
 */
export async function captureScrollableContainer(page, selector, { x, y, width, height }, VW, VH, windowScrollWorks) {
  if (!selector) throw new Error("could not find scroll container selector");

  // reset to top of inner scroll container before starting
  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (el) el.scrollTop = 0;
  }, selector);

  await waitFor(page,80);

  // measure the container
  const { containerScrollH, containerClientH } = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    return el ? { containerScrollH: el.scrollHeight, containerClientH: el.clientHeight } : { containerScrollH: 0, containerClientH: 0 };
  }, selector);

  console.log(`  [scroll-container] selector=${selector} scrollH=${containerScrollH} clientH=${containerClientH}`);

  // bring container into viewport
  if (windowScrollWorks) {
    await page.evaluate((scrollY) => window.scrollTo(0, scrollY), Math.max(0, y));
    await waitFor(page,80);
  }

  const strips = [];
  let scrollTop = 0;

  while (true) {
    const winScrollY = await page.evaluate(() => window.scrollY);
    const clipY = Math.max(0, y - winScrollY);
    const clipH = Math.min(height, VH - clipY);
    const clipX = Math.max(0, Math.min(x, VW - 1));
    const clipW = Math.min(width, VW - clipX);

    if (clipW > 0 && clipH > 0) {
      const buf = await page.screenshot({
        clip: { x: clipX, y: clipY, width: clipW, height: clipH },
        fullPage: false,
      });
      strips.push({ buffer: buf, scrollTop, clipH });
    }

    const nextScroll = scrollTop + containerClientH;
    if (nextScroll >= containerScrollH) break;

    await page.evaluate(
      ({ sel, top }) => {
        const el = document.querySelector(sel);
        if (el) el.scrollTop = top;
      },
      { sel: selector, top: nextScroll },
    );
    await waitFor(page,80);

    const actualScroll = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      return el ? el.scrollTop : 0;
    }, selector);

    if (actualScroll === scrollTop) break;
    scrollTop = actualScroll;
  }

  // reset container scroll
  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (el) el.scrollTop = 0;
  }, selector);

  if (strips.length === 0) throw new Error("no strips captured from scroll container");
  if (strips.length === 1) return strips[0].buffer;

  // stitch: each strip contributes only the new rows it introduced
  const canvasW = (await sharp(strips[0].buffer).metadata()).width;
  const composites = [];
  let canvasH = 0;

  for (let i = 0; i < strips.length; i++) {
    const { buffer, scrollTop: sTop, clipH } = strips[i];
    const nextSTop = i + 1 < strips.length ? strips[i + 1].scrollTop : containerScrollH;
    const newRows = Math.min(nextSTop - sTop, clipH);
    if (newRows < 1) continue;

    const cropped = await sharp(buffer).extract({ left: 0, top: 0, width: canvasW, height: newRows }).png().toBuffer();

    composites.push({ input: cropped, top: canvasH, left: 0 });
    canvasH += newRows;
  }

  return sharp({
    create: {
      width: canvasW,
      height: canvasH,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite(composites)
    .png()
    .toBuffer();
}
