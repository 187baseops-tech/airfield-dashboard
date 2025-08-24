import express from "express";
import fs from "fs";
import path from "path";
import multer from "multer";
import cors from "cors";

const app = express();
const PORT = 4000;

// Enable CORS so frontend can talk to backend
app.use(cors());

// Paths
const dataDir = path.join(process.cwd(), "data");
const slidesDir = path.join(dataDir, "slides");
const annotsFile = path.join(dataDir, "annotations.json");

// Ensure directories exist
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);
if (!fs.existsSync(slidesDir)) fs.mkdirSync(slidesDir);
if (!fs.existsSync(annotsFile)) fs.writeFileSync(annotsFile, JSON.stringify({ slides: {} }, null, 2));

app.use(express.json());
app.use("/slides", express.static(slidesDir)); // serve images at /slides/filename.png

// ---- Annotations API ----

// GET all annotations
app.get("/api/annotations", (req, res) => {
  const data = JSON.parse(fs.readFileSync(annotsFile, "utf8"));
  res.json(data);
});

// POST update annotations
app.post("/api/annotations", (req, res) => {
  fs.writeFileSync(annotsFile, JSON.stringify(req.body, null, 2));
  res.json({ status: "ok" });
});

// ---- Slides API ----

// List available slides
app.get("/api/slides", (req, res) => {
  const files = fs.readdirSync(slidesDir).filter(f => /\.(png|jpg|jpeg)$/i.test(f));
  res.json(files.map(f => `/slides/${f}`));
});

// Upload new slide
const upload = multer({ dest: slidesDir });
app.post("/api/slides", upload.single("slide"), (req, res) => {
  const tempPath = req.file.path;
  const targetPath = path.join(slidesDir, req.file.originalname);

  fs.renameSync(tempPath, targetPath);
  res.json({ status: "uploaded", file: `/slides/${req.file.originalname}` });
});

// ---- Start Server ----
app.listen(PORT, () => console.log(`✅ Backend running on http://localhost:${PORT}`));
