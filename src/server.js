import "dotenv/config";
import express from "express";
import cors from "cors";
import multer from "multer";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

import pagesRouter from "./routes/pages.js";
import compareSiteRouter from "./routes/compareSite.js";
import compareRouter from "./routes/compareImages.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUTS_DIR = path.resolve(__dirname, "outputs");
const UPLOADS_DIR = path.resolve(__dirname, "uploads");

if (!fs.existsSync(OUTPUTS_DIR)) fs.mkdirSync(OUTPUTS_DIR, { recursive: true });
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const application = express();
const uploads = multer({ dest: UPLOADS_DIR });

// ── CORS ─────────────────────────────────────────────────────────────────────
const rawOrigins = process.env.ALLOWED_ORIGINS ?? "";
const allowedOrigins = rawOrigins
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

application.use(
  cors({
    origin:
      allowedOrigins.length === 1 && allowedOrigins[0] === "*"
        ? "*"
        : (origin, callback) => {
            if (!origin) return callback(null, true);
            if (allowedOrigins.includes(origin)) return callback(null, true);
            callback(new Error(`CORS: origin "${origin}" is not allowed`));
          },
  }),
);

// ── Middleware ────────────────────────────────────────────────────────────────
application.use(express.json());
application.use("/outputs", express.static(OUTPUTS_DIR));

// ── File upload middleware injected into the compare route ───────────────────
application.use("/compare", uploads.fields([{ name: "liveImage" }, { name: "stagedImage" }]));

// ── Routes ────────────────────────────────────────────────────────────────────
application.use(pagesRouter);
application.use(compareSiteRouter);
application.use(compareRouter);

// ── Server bootstrap ──────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT);
const server = application.listen(PORT, () => console.log(`Server running on port ${PORT}`));

server.on("error", (err) => console.error("Server error:", err));
process.on("uncaughtException", (err) => console.error("Uncaught exception:", err));
process.on("unhandledRejection", (reason) => console.error("Unhandled rejection:", reason));
process.stdin.resume();
