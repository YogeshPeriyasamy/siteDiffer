import { withTimeout } from "./withTimeout.js";

export async function runSignal(signal, page, logs) {
  const start = Date.now();
  try {
    await withTimeout(signal.run(page), signal.timeout, signal.name);

    logs.logs.push({
      name: signal.name,
      status: "completed",
      duration: Date.now() - start,
    });
  } catch (err) {
    logs.logs.push({
      name: signal.name,
      status: "failed",
      duration: Date.now() - start,
      error: err.message,
    });
  }
}
