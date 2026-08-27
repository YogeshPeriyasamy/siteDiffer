const store = new Map();

const listeners = new Map();

// How long to keep a finished job in memory (30 minutes)
const TTL_MS = 30 * 60 * 1000;

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Creates and registers a new job. Returns the full job record.
 */
export function createJob(runId) {
  const job = {
    runId,
    status: "queued",
    phase: "Initialising",
    progress: 0,
    result: null,
    error: null,
    createdAt: Date.now(),
  };
  store.set(runId, job);
  return job;
}

export function mapJob(runId, callBack) {
  if (!listeners.has(runId)) listeners.set(runId, new Set());
  listeners.get(runId).add(callBack);
  return () => listeners.get(runId).delete(callBack);
}

export function notify(runId) {
  const job = store.get(runId);
  const callBacks = listeners.get(runId);
  if (!callBacks) return;
  callBacks.forEach((cb) => cb(job));
}
/**
 * Retrieves a job by runId. Returns undefined when not found.
 */
export function getJob(runId) {
  return store.get(runId);
}

/**
 * Partially updates a job's mutable fields (phase, progress, status, etc.).
 */
export function updateJob(runId, patch) {
  const job = store.get(runId);
  if (!job) return;
  Object.assign(job, patch);
  notify(runId);
}

/**
 * Marks a job as done and attaches the final result payload.
 */
export function completeJob(runId, result) {
  updateJob(runId, { status: "done", phase: "Done", progress: 100, result });
  scheduleEviction(runId);
}

/**
 * Marks a job as errored.
 */
export function failJob(runId, errorMessage) {
  updateJob(runId, { status: "error", error: errorMessage });
  scheduleEviction(runId);
}

export function deleteJob(runId) {
  store.delete(runId);
  listeners.delete(runId);
}

// ── Internal ──────────────────────────────────────────────────────────────

function scheduleEviction(runId) {
  setTimeout(() => {
    store.delete(runId);
    listeners.delete(runId);
  }, TTL_MS);
}
