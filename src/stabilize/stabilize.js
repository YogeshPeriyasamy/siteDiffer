import { runSignal } from "./signalHandler.js";

import { disableAnimations } from "./preprocessors/disableAnimation.js";
import { scrollPage } from "./preprocessors/scrollPage.js";
import { removeAdds } from "./preprocessors/removeAds.js";

import { readyStateSignal } from "./signals/readyState.js";
import { domStabilitySignal } from "./signals/domStability.js";
import { imgSignal } from "./signals/imageLoad.js";
import { fontSignal } from "./signals/fontLoad.js";
import { loaderSignal } from "./signals/loader.js";
import { networkSignal } from "./signals/network.js";
import { frameSignal } from "./signals/frame.js";

export async function stabilize(page, config) {
  const { scroll, readyState, dom, network, loaders, images, fonts, frame } = config;
  const logs = {
    startTime: Date.now(),
    logs: [],
  };

  const signalFactories = [
    readyStateSignal(readyState),
    domStabilitySignal(dom),
    imgSignal(images),
    fontSignal(fonts),
    loaderSignal(loaders),
    networkSignal(network),
    frameSignal(frame),
  ];
  const signals = await Promise.all(signalFactories);

  await scrollPage(page, scroll);
  await disableAnimations(page);
  await removeAdds(page);

  for (const signal of signals) {
    await runSignal(signal, page, logs);
  }

  return logs;
}
