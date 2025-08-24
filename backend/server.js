import express from "express";
import fs from "fs";
import path from "path";
import multer from "multer";
import cors from "cors";

const app = express();

// --- PORT (Render provides PORT env var) ---
const PORT = process.env.PORT || 4000;

// --- Paths ---
const dataDir = path.join(process.cwd(), "data");
const slidesDir = path.join(dataDir, "slides");
const annotsFile = path.join(dataDir, "annotations.json");

// --- Ensure directories and files exist ---
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);
if (!fs.existsSync(slidesDir)) fs.mkdirSync(slidesDir);
if (!fs.existsSync(annotsFile)) {
  fs.writeFileSync(annotsFile, JSON.stringify({ slides: {} }, null, 2));
}

// --- Middleware ---
app.use(cors());               // Allow frontend to call backend
app.use(express.json());       // Parse JSON bodies
app.use("/slides", express.static(slidesDir)); // Serve slide images

// ==================== Annotations API ====================

// GET all annotations
app.get("/api/annotations", (req, res) => {
  try {
    const data = JSON.parse(fs.readFileSync(annotsFile, "utf8"));
    res.json(data);
  } catch (err) {
    console.error("Error reading annotations:", err);
    res.status(500).json({ error: "Failed to read annotations" });
  }
});

// POST update annotations
app.post("/api/annotations", (req, res) => {
  try {
    fs.writeFileSync(annotsFile, JSON.stringify(req.body, null, 2));
    res.json({ status: "ok" });
  } catch (err) {
    console.error("Error writing annotations:", err);
    res.status(500).json({ error: "Failed to save annotations" });
  }
});

// ==================== Slides API ====================

// List available slides
app.get("/api/slides", (req, res) => {
  try {
    const files = fs
      .readdirSync(slidesDir)
      .filter(f => /\.(png|jpg|jpeg)$/i.test(f));
    res.json(files.map(f => `/slides/${f}`));
  } catch (err) {
    console.error("Error listing slides:", err);
    res.status(500).json({ error: "Failed to list slides" });
  }
});

// Upload new slide
const upload = multer({ dest: slidesDir });
app.post("/api/slides", upload.single("slide"), (req, res) => {
  try {
    const tempPath = req.file.path;
    const targetPath = path.join(slidesDir, req.file.originalname);
    fs.renameSync(tempPath, targetPath);
    res.json({ status: "uploaded", file: `/slides/${req.file.originalname}` });
  } catch (err) {
    console.error("Error uploading slide:", err);
    res.status(500).json({ error: "Failed to upload slide" });
  }
});

// ==================== Start Server ====================
app.listen(PORT, () => {
  console.log(`✅ Backend running on port ${PORT}`);
});
