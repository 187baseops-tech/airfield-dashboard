import express from "express";
import fs from "fs";
import path from "path";
import multer from "multer";
import cors from "cors";
import axios from "axios";

const app = express();
const PORT = process.env.PORT || 4000;

// Enable CORS
app.use(cors());

// Paths
const dataDir = path.join(process.cwd(), "data");
const slidesDir = path.join(dataDir, "slides");
const annotsFile = path.join(dataDir, "annotations.json");

// Ensure directories exist
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);
if (!fs.existsSync(slidesDir)) fs.mkdirSync(slidesDir);
if (!fs.existsSync(annotsFile))
  fs.writeFileSync(annotsFile, JSON.stringify({ slides: {} }, null, 2));

app.use(express.json());
app.use("/slides", express.static(slidesDir)); // serve slide images

// ---- Annotations API ----
app.get("/api/annotations", (req, res) => {
  const data = JSON.parse(fs.readFileSync(annotsFile, "utf8"));
  res.json(data);
});

app.post("/api/annotations", (req, res) => {
  fs.writeFileSync(annotsFile, JSON.stringify(req.body, null, 2));
  res.json({ status: "ok" });
});

// ---- Slides API ----
app.get("/api/slides", (req, res) => {
  const files = fs.readdirSync(slidesDir).filter(f => /\.(png|jpg|jpeg)$/i.test(f));
  res.json(files); // return just filenames
});

const upload = multer({ dest: slidesDir });
app.post("/api/slides", upload.single("slide"), (req, res) => {
  const tempPath = req.file.path;
  const targetPath = path.join(slidesDir, req.file.originalname);

  fs.renameSync(tempPath, targetPath);
  res.json({ status: "uploaded", file: req.file.originalname });
});

// ---- Weather APIs ----
// METAR
app.get("/api/metar", async (req, res) => {
  try {
    const { icao } = req.query;
    const url = `https://aviationweather.gov/api/data/metar?ids=${icao}&format=json`;
    const { data } = await axios.get(url);
    res.json(data[0] || {}); // return first station result
  } catch (err) {
    console.error("METAR fetch error:", err.message);
    res.status(500).json({ error: "Failed to fetch METAR" });
  }
});

// TAF
app.get("/api/taf", async (req, res) => {
  try {
    const { icao } = req.query;
    const url = `https://aviationweather.gov/api/data/taf?ids=${icao}&format=json`;
    const { data } = await axios.get(url);
    res.json(data[0] || {});
  } catch (err) {
    console.error("TAF fetch error:", err.message);
    res.status(500).json({ error: "Failed to fetch TAF" });
  }
});

// NOTAMs (using NOAA aviationweather.gov)
app.get("/api/notams", async (req, res) => {
  try {
    const { icao } = req.query;
    const url = `https://aviationweather.gov/api/data/notam?ids=${icao}&format=json`;
    const { data } = await axios.get(url, { timeout: 10000 });

    res.json({ notams: data || [] });
  } catch (err) {
    console.error("NOTAM fetch error:", err.message);
    res.status(500).json({ error: "Failed to fetch NOTAMs" });
  }
});



// ---- Start Server ----
app.listen(PORT, () => console.log(`✅ Backend running on port ${PORT}`));
