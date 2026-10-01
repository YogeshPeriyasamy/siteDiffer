import { chromium } from "playwright";

export async function getBrowser() {
  return await chromium.launch({
    headless: true,
    // args: ["--autoplay-policy=user-gesture-required"],
  });
}
