import express from "express";
import axios from "axios";
import * as cheerio from "cheerio";
import cors from "cors";
import https from "https";
import fs from "fs";
import path from "path";

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());

const SLIDES_DIR = path.join(process.cwd(), "slides");
const ANNOT_FILE = "./annotations.json";

// ---- NOTAM Scraper ----
async function fetchNotams(icao = "KMGM") {
  try {
    console.log(`🌐 Scraping NOTAMs for ${icao} from OurAirports...`);
    const httpsAgent = new https.Agent({ rejectUnauthorized: false });
    const { data: html } = await axios.get(
      `https://ourairports.com/airports/${icao}/notams.html`,
      { httpsAgent }
    );

    const $ = cheerio.load(html);
    const notams = [];

    // More flexible selector
    $("a[id^=notam-], div#notams a").each((_, el) => {
      const text = $(el).text().trim();
      if (!text) return;

      const cleaned = text
        .replace(/Montgomery Regional.*?\(KMGM\)/gi, "(KMGM)")
        .replace(/\s?NOTAMN/g, "")
        .trim();

      const match = cleaned.match(/(M?\d{3,4}\/\d{2}|\d{2}\/\d{3,4})/);
      const id = match ? match[0] : cleaned.slice(0, 12);

      notams.push({ id, text: cleaned });
    });

    console.log(`✅ Scraped ${notams.length} NOTAMs`);
    return notams;
  } catch (err) {
    console.error("❌ OurAirports scraper failed:", err.message);
    return [];
  }
}

// ---- Existing Routes ----
app.get("/", (req, res) => res.send("✅ Airfield Dashboard Backend running"));
app.get("/api/notams", async (req, res) => {
  const icao = req.query.icao || "KMGM";
  const notams = await fetchNotams(icao);
  res.json({ notams });
});

// ---- Slides + Annotations ----
app.use("/slides", express.static(SLIDES_DIR));

app.get("/api/slides", (req, res) => {
  try {
    if (!fs.existsSync(SLIDES_DIR)) return res.json([]);
    const files = fs.readdirSync(SLIDES_DIR).filter(f => /\.(png|jpg|jpeg)$/i.test(f));
    res.json(files);
  } catch (err) {
    console.error("❌ Failed to read slides:", err.message);
    res.json([]);
  }
});

app.get("/api/annotations", (req, res) => {
  if (fs.existsSync(ANNOT_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(ANNOT_FILE));
      res.json(data);
    } catch {
      res.json({ slides: {} });
    }
  } else {
    res.json({ slides: {} });
  }
});

app.post("/api/annotations", (req, res) => {
  try {
    fs.writeFileSync(ANNOT_FILE, JSON.stringify(req.body, null, 2));
    res.json({ ok: true });
  } catch (err) {
    console.error("❌ Failed to save annotations:", err.message);
    res.status(500).json({ ok: false });
  }
});

// ---- Weather/NAVAIDs/BASH already present ----
// ... keep those unchanged ...

app.listen(PORT, () => {
  console.log(`🚀 Backend listening on port ${PORT}`);
});
