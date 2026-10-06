import { Router } from "express";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";
import { fileURLToPath } from "url";

import { createJob, getJob, updateJob, completeJob, failJob, mapJob, deleteJob } from "../services/jobStore.js";
import { runComparison } from "../services/compareSiteService.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUTS_DIR = path.resolve(__dirname, "..", "outputs");

const router = Router();

router.post("/compare-site", async (req, res) => {
  const { pages, selectedDisplayResolution = "desktop", threshold = 0.4, isFullpageCapture = true } = req.body;

  // console.log("pages", pages, threshold, isFullpageCapture);

  const runId = randomUUID();
  createJob(runId);

  // const result = await runComparison({ runId, selectedDisplayResolution, pages, threshold })
  // return result;

  res.status(202).json({ runId });

  setImmediate(() => {
    runComparison({ runId, selectedDisplayResolution, pages, threshold, OUTPUTS_DIR, isFullpageCapture }).catch((err) => {
      console.error(`[compare-site] Unhandled top-level error for run ${runId}:`, err);
      failJob(runId, err.message ?? "Unknown error");
    });
  });
});

// ── GET /compare-site/:runId/status ──────────────────────────────────────────
// Polled by the frontend every N ms while the job is running.
// ─────────────────────────────────────────────────────────────────────────────
router.get("/compare-site/:runId/status", (req, res) => {
  const job = getJob(req.params.runId);
  if (!job) return res.status(404).json({ message: "Job not found" });

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  // Race guard: job may already be finished when client connects
  if (job.status === "done") {
    send({ status: "done", result: job.result });
    return res.end();
  }
  if (job.status === "error") {
    send({ status: "error", error: job.error });
    return res.end();
  }
  send({ status: "running", phase: job.phase, progress: job.progress });

  const unMap = mapJob(req.params.runId, (updated) => {
    if (updated.status === "done") {
      send({ status: "done", result: updated.result });
      unMap();
      res.end();
    } else if (updated.status === "error") {
      send({ status: "error", error: updated.error });
      unMap();
      res.end();
    } else {
      send({ status: "running", phase: updated.phase, progress: updated.progress });
    }
  });

  req.on("close", unMap);
});

router.delete("/compare-site/:runId", (req, res) => {
  const runId = req.params.runId;
  console.log(`Delete request for ${runId}`);
  if (!runId) return;
  deleteJob(runId);

  const runDir = path.join(OUTPUTS_DIR, runId);
  if (fs.existsSync(runDir)) {
    fs.rmSync(runDir, { recursive: true, force: true });
    console.log(`Deleted ${runDir}`);
  }
  res.end(); // to notify browser the request is completed
});

export default router;
