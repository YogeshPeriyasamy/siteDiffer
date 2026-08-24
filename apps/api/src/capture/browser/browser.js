import { chromium } from "playwright";

export async function getBrowser() {
  return await chromium.launch({
    headless: true,
  });
}
