import express from "express";
import fs from "fs";
import path from "path";
import multer from "multer";
import cors from "cors";
import axios from "axios";

const app = express();
const PORT = process.env.PORT || 4000;

// Enable CORS so frontend can talk to backend
app.use(cors());
app.use(express.json());

// --- Paths ---
const dataDir = path.join(process.cwd(), "data");
const slidesDir = path.join(dataDir, "slides");
const annotsFile = path.join(dataDir, "annotations.json");

// Ensure directories exist
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);
if (!fs.existsSync(slidesDir)) fs.mkdirSync(slidesDir);
if (!fs.existsSync(annotsFile)) {
  fs.writeFileSync(
    annotsFile,
    JSON.stringify({ slides: {} }, null, 2)
  );
}

// Serve slide images
app.use("/slides", express.static(slidesDir));

/* -------------------------------
   ANNOTATIONS API
--------------------------------*/

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
    fs.writeFileSync(
      annotsFile,
      JSON.stringify(req.body, null, 2)
    );
    res.json({ status: "ok" });
  } catch (err) {
    console.error("Error writing annotations:", err);
    res.status(500).json({ error: "Failed to save annotations" });
  }
});

/* -------------------------------
   SLIDES API
--------------------------------*/

// List available slides
app.get("/api/slides", (req, res) => {
  try {
    const files = fs
      .readdirSync(slidesDir)
      .filter((f) => /\.(png|jpg|jpeg)$/i.test(f));
    res.json(files.map((f) => f));
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
    res.json({ status: "uploaded", file: req.file.originalname });
  } catch (err) {
    console.error("Error uploading slide:", err);
    res.status(500).json({ error: "Failed to upload slide" });
  }
});

/* -------------------------------
   WEATHER + NOTAMS PROXY API
   (Fetch live data from aviationweather.gov)
--------------------------------*/

const AVWX_BASE = "https://aviationweather.gov/api/data";

// Proxy for METAR
app.get("/api/metar", async (req, res) => {
  try {
    const { icao } = req.query;
    const url = `${AVWX_BASE}/metar?ids=${icao}&format=json`;
    const r = await axios.get(url);
    res.json(r.data[0] || { raw: "" });
  } catch (err) {
    console.error("Error fetching METAR:", err.message);
    res.status(500).json({ error: "Failed to fetch METAR" });
  }
});

// Proxy for TAF
app.get("/api/taf", async (req, res) => {
  try {
    const { icao } = req.query;
    const url = `${AVWX_BASE}/taf?ids=${icao}&format=json`;
    const r = await axios.get(url);
    res.json(r.data[0] || { raw: "" });
  } catch (err) {
    console.error("Error fetching TAF:", err.message);
    res.status(500).json({ error: "Failed to fetch TAF" });
  }
});

// Proxy for NOTAMs
app.get("/api/notams", async (req, res) => {
  try {
    const { icao } = req.query;
    const url = `${AVWX_BASE}/notam?ids=${icao}&format=json`;
    const r = await axios.get(url);
    res.json({ notams: r.data || [] });
  } catch (err) {
    console.error("Error fetching NOTAMs:", err.message);
    res.status(500).json({ error: "Failed to fetch NOTAMs" });
  }
});

/* -------------------------------
   START SERVER
--------------------------------*/
app.listen(PORT, () =>
  console.log(`✅ Backend running on http://localhost:${PORT}`)
);
