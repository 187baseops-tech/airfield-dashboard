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

// ---- Persistent State ----
const STATE_FILE = "./state.json";
let savedState = {
  navaids: { mgm: "IN", mxf: "IN", ils10: "IN", ils28: "IN" },
  bash: {
    KMGM: "LOW",
    KMXF: "LOW",
    PHCR_MOA: "LOW",
    BHM_MOA: "LOW",
    VR060: "LOW",
    VR1056: "LOW",
    ShelbyRange: "LOW",
  },
  airfield: {
    activeRunway: "10",
    rsc: "DRY",
    rscNotes: "",
    barriers: { east: "DOWN", west: "DOWN" },
    arff: "GREEN",
  },
};
if (fs.existsSync(STATE_FILE)) {
  try {
    savedState = JSON.parse(fs.readFileSync(STATE_FILE));
  } catch {
    console.warn("⚠ Failed to parse saved state, using defaults");
  }
}
function saveState() {
  fs.writeFileSync(STATE_FILE, JSON.stringify(savedState, null, 2));
}

// ---- Slides / Annotations ----
const SLIDES_DIR = path.join(process.cwd(), "../data/slides");
const ANNOT_FILE = path.join(SLIDES_DIR, "annotations.json");

console.log("⚙️ process.cwd():", process.cwd());
console.log("⚙️ SLIDES_DIR is set to:", SLIDES_DIR);
console.log("⚙️ ANNOT_FILE is set to:", ANNOT_FILE);

// ---- NOTAM Scraper with Cache ----
let notamCache = { ts: 0, data: [] };

async function fetchNotams(icao = "KMGM", force = false) {
  const now = Date.now();
  if (!force && now - notamCache.ts < 15 * 60 * 1000) {
    console.log("⏳ Returning cached NOTAMs");
    return notamCache.data;
  }

  try {
    console.log(`🌐 Scraping NOTAMs for ${icao}...`);
    const httpsAgent = new https.Agent({ rejectUnauthorized: false });
    const { data: html } = await axios.get(
      `https://ourairports.com/airports/${icao}/notams.html`,
      { httpsAgent }
    );

    const $ = cheerio.load(html);
    const notams = [];

    $("section[id^=notam-]").each((_, el) => {
      const header = $(el).find("h3").text().trim();
      const body = $(el).find("p.notam").text().trim();
      if (!header || !body) return;

      const match = header.match(
        /(M?\d{3,4}\/\d{2}|!\w{3}\s+\d{2}\/\d{3,4}|FDC\s*\d{1,4}\/\d{2})/
      );
      const id = match ? match[0] : header.slice(0, 20);

      const locMatch = header.match(/\(KMGM\)/);
      const location = locMatch ? " (KMGM)" : "";

      const lines = body.split("\n").map((l) => l.trim());
      const cleanedLines = [];
      for (const line of lines) {
        if (/^\w{4,}\s+NOTAMN/.test(line)) continue;
        if (line.startsWith("Q)")) {
          const abcMatch = line.match(/A\).*?B\).*?C\)[^ ]*/);
          if (abcMatch) cleanedLines.push(abcMatch[0]);
          continue;
        }
        if (line.startsWith("CREATED:")) continue;
        if (line.startsWith("SOURCE:")) continue;
        cleanedLines.push(line);
      }

      notams.push({
        id,
        text: `${id}${location}\n${cleanedLines.join("\n")}`,
      });
    });

    // 🔹 Detect Navaid outages
    const outageKeywords = ["U/S", "UNSERVICEABLE", "OUT OF SERVICE"];
    const navaidOutages = { mgm: "IN", ils10: "IN", ils28: "IN" };

    for (const n of notams) {
      const t = n.text.toUpperCase();
      if (outageKeywords.some((w) => t.includes(w))) {
        if (t.includes("ILS 10")) navaidOutages.ils10 = "OUT";
        if (t.includes("ILS 28")) navaidOutages.ils28 = "OUT";
        if (t.includes("MGM TACAN") || (t.includes("MGM") && t.includes("TACAN"))) {
          navaidOutages.mgm = "OUT";
        }
      }
    }

    savedState.navaids = { ...savedState.navaids, ...navaidOutages };
    saveState();

    notamCache = { ts: now, data: notams };
    console.log(`✅ Found ${notams.length} NOTAMs`);
    return notams;
  } catch (err) {
    console.error("❌ NOTAM scrape failed:", err.message);
    return [];
  }
}

// ---- Routes ----
app.get("/", (req, res) => res.send("✅ Airfield Dashboard Backend running"));

// NOTAMs
app.get("/api/notams", async (req, res) => {
  const icao = req.query.icao || "KMGM";
  const force = req.query.force === "1";
  const notams = await fetchNotams(icao, force);
  res.json({ notams });
});

// Weather live fetch
app.get("/api/metar", async (req, res) => {
  const icao = req.query.icao || "KMGM";
  try {
    const { data } = await axios.get(
      `https://aviationweather.gov/api/data/metar?ids=${icao}&format=raw&hours=1`
    );
    res.json({ raw: data.trim() });
  } catch (err) {
    console.error("❌ METAR fetch failed:", err.message);
    res.json({ raw: `${icao} -- METAR unavailable` });
  }
});

app.get("/api/taf", async (req, res) => {
  const icao = req.query.icao || "KMGM";
  try {
    const { data } = await axios.get(
      `https://aviationweather.gov/api/data/taf?ids=${icao}&format=raw&hours=1`
    );
    res.json({ raw: data.trim() });
  } catch (err) {
    console.error("❌ TAF fetch failed:", err.message);
    res.json({ raw: `${icao} -- TAF unavailable` });
  }
});

// State persistence (unified)
app.get("/api/state", (req, res) => res.json(savedState));
app.post("/api/state", (req, res) => {
  savedState = { ...savedState, ...req.body };
  saveState();
  res.json({ ok: true, state: savedState });
});

// Slides + Annotations
app.use("/slides", express.static(SLIDES_DIR));
app.get("/api/slides", (req, res) => {
  try {
    if (!fs.existsSync(SLIDES_DIR)) return res.json([]);
    const files = fs.readdirSync(SLIDES_DIR);
    const images = files.filter((f) => /\.(png|jpg|jpeg)$/i.test(f));
    res.json(images);
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

// ---- Start ----
app.listen(PORT, () => {
  console.log(`🚀 Backend listening on port ${PORT}`);
});
