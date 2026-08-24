export async function readyStateSignal(config) {
  const { timeoutMs } = config;

  // console.log("ready state timeout", timeoutMs)

  return {
    name: "readyState",
    timeout: timeoutMs,
    failSafe: false,
    run: (page) =>
      page.waitForFunction(
        () => document.readyState === "complete",
        null,
        { timeout: timeoutMs },
      ),
  };
}


//playwright syntax  --> page.waitForFunction(function(),args,options) timeout is option