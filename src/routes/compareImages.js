import { Router } from "express";

import { compareImages } from "../core/index.js";

const router = Router();

// ---------------------------------------------------------------------------
// POST /compare
//
// Accepts two image files via multipart upload (liveImage, stagedImage).
// Returns the diff PNG directly as image/png.
// ---------------------------------------------------------------------------
router.post("/compare", async (req, res) => {
  try {
    const liveImagePath   = req.files?.["liveImage"]?.[0]?.path;
    const stagedImagePath = req.files?.["stagedImage"]?.[0]?.path;

    if (!liveImagePath || !stagedImagePath) {
      return res.status(400).json({ message: "liveImage and stagedImage are required" });
    }

    const { buffer } = await compareImages(liveImagePath, stagedImagePath);
    res.set("Content-Type", "image/png");
    return res.send(buffer);
  } catch (error) {
    console.error("Error processing images:", error);
    return res.status(500).json({ message: "Error processing images", error: error.message });
  }
});

export default router;
