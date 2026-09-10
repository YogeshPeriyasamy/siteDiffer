import { captureConfig } from "../capture/config.js";


export async function getPagesForSite(url,browser) {
const context = await browser.newContext({
    viewport: captureConfig.viewport,
    deviceScaleFactor: captureConfig.deviceScaleFactor,
  });

  try {
    const page = await context.newPage();

    await page.goto(url, {
      waitUntil: captureConfig.waitUntil,
      timeout: captureConfig.timeout,
    });

    const pages = await page.evaluate(() => {
        const currentOrigin = window.location.origin;
        const anchors = Array.from(document.querySelectorAll("a"));
    });
  }catch (error) {
    console.error("Error creating new page for page extraction:", error);
  }finally {
    await context.close();
  }
}