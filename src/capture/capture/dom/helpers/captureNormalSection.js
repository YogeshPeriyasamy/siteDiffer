// import sharp from "sharp";

// import { normalizeStrip } from "./normalization.js";
// import { waitFor } from "./helper.js";

// /**
//  * Normal section — scrolls the window and stitches viewport-height strips.
//  * Returns a raw buffer (caller normalizes to exact size).
//  */
// export async function captureNormalSection(page, { x, y, width, height }, VW, VH, pageH, windowScrollWorks) {
//   const clipX = Math.max(0, Math.min(x, VW - 1));
//   const clipW = Math.min(width, VW - clipX);

//   // window scroll broken → fullPage screenshot + crop
//   if (!windowScrollWorks) {
//     const full = await page.screenshot({ fullPage: true });
//     const meta = await sharp(full).metadata();
//     const safeY = Math.min(y, meta.height - 1);
//     const safeH = Math.min(height, meta.height - safeY);
//     return sharp(full).extract({ left: clipX, top: safeY, width: clipW, height: safeH }).png().toBuffer();
//   }

//   const strips = [];
//   let capturedHeight = 0;

//   while (capturedHeight < height) {
//     const absoluteY = y + capturedHeight;
//     const remainingH = height - capturedHeight;
//     const scrollTo = Math.min(absoluteY, Math.max(0, pageH - VH));

//     await page.evaluate((scrollY) => window.scrollTo(0, scrollY), scrollTo);
//     await waitFor(page,60);

//     const actualScroll = await page.evaluate(() => window.scrollY);
//     const clipY = absoluteY - actualScroll;
//     const clipH = Math.min(remainingH, VH - clipY);

//     if (clipY < 0 || clipY >= VH || clipH < 1) {
//       const fallbackY = Math.max(0, Math.min(absoluteY - actualScroll, VH - 1));
//       const fallbackH = Math.min(remainingH, VH - fallbackY);
//       if (fallbackH < 1) break;

//       const buf = await page.screenshot({
//         clip: { x: clipX, y: fallbackY, width: clipW, height: fallbackH },
//         fullPage: false,
//       });
//       strips.push({ buffer: await normalizeStrip(buf, clipW, fallbackH), height: fallbackH });
//       capturedHeight += fallbackH;
//       continue;
//     }

//     const buf = await page.screenshot({
//       clip: { x: clipX, y: clipY, width: clipW, height: clipH },
//       fullPage: false,
//     });
//     strips.push({ buffer: await normalizeStrip(buf, clipW, clipH), height: clipH });
//     capturedHeight += clipH;
//   }

//   if (strips.length === 0) throw new Error("no strips captured");
//   if (strips.length === 1) return strips[0].buffer;

//   const totalH = strips.reduce((sum, strip) => sum + strip.height, 0);
//   const composites = [];
//   let offsetY = 0;

//   for (const strip of strips) {
//     composites.push({ input: strip.buffer, top: offsetY, left: 0 });
//     offsetY += strip.height;
//   }

//   return sharp({
//     create: {
//       width: clipW,
//       height: totalH,
//       channels: 4,
//       background: { r: 0, g: 0, b: 0, alpha: 0 },
//     },
//   })
//     .composite(composites)
//     .png()
//     .toBuffer();
// }

export async function captureNormalSection(page, section) {
  const safeX = Math.max(0, Math.round(section.x));
  const safeY = Math.max(0, Math.round(section.y));
  const safeW = Math.min(Math.round(section.width), fullMeta.width - safeX);
  const safeH = Math.min(Math.round(section.height), fullMeta.height - safeY);

  if (safeW < 1 || safeH < 1) {
    throw new Error(`invalid crop size ${safeW}x${safeH}`);
  }

  const buffer = await sharp(fullPageBuffer)
    .extract({
      left: safeX,
      top: safeY,
      width: safeW,
      height: safeH,
    })
    .png()
    .toBuffer();

  capturedMapped[key] = {
    ...section,
    x: safeX,
    y: safeY,
    width: safeW,
    height: safeH,
    buffer,
    fullBuffer: null,
    expansion: 0,
    floating: false,
    error: null,
  };
}
