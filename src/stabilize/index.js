import { defaultConfig } from "./config.js";
import { stabilize } from "./stabilize.js";

export async function stabilizePage(page) {
  console.log("...stabilizing page");
  const stabilizeLogs = await stabilize(page, defaultConfig);
  console.log("stabilized logs", stabilizeLogs);
  return stabilizeLogs;
}
