import { defaultConfig } from "./config/stabilizeConfig.js";
import { stabilize } from "./stabilize/stabilize.js";

export async function stabilizePage(page) {
  console.log("...stabilizing page");
  const stabilizeLogs = await stabilize(page, defaultConfig);
  console.log("stabilized logs", stabilizeLogs);
  return stabilizeLogs;
}
