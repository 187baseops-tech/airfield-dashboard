import express from "express";
import axios from "axios";
import * as cheerio from "cheerio";
import cors from "cors";
import https from "https";
import fs from "fs";

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());

const STATE_FILE = "./state.json";

// ✅ Load state from disk if available
let savedState = {
  navaids: { mgm: true, mxf: true, ils10: true, ils28: false },
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

// ✅ Persist helper
function saveState() {
  fs.writeFileSync(STATE_FILE, JSON.stringify(savedState, null, 2));
}

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
    $("a[id^=notam-]").each((_, el) => {
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
    return notams;
  } catch (err) {
    console.error("❌ NOTAM scrape failed:", err.message);
    return [];
  }
}

// ---- API Routes ----
app.get("/", (req, res) => {
  res.send("✅ Airfield Dashboard Backend running");
});

// NOTAMs
app.get("/api/notams", async (req, res) => {
  const icao = req.query.icao || "KMGM";
  const notams = await fetchNotams(icao);
  res.json({ notams });
});

// Weather
app.get("/api/metar", (req, res) => {
  const icao = req.query.icao || "KMGM";
  res.json({ raw: `${icao} 251755Z AUTO 00000KT 10SM CLR 30/18 A2992 RMK AO2` });
});

app.get("/api/taf", (req, res) => {
  const icao = req.query.icao || "KMGM";
  res.json({ raw: `${icao} 251730Z 2518/2618 18005KT P6SM SCT050 BKN200` });
});

// ✅ Persisted State Endpoints
app.get("/api/state", (req, res) => {
  res.json(savedState);
});

app.post("/api/state", (req, res) => {
  savedState = { ...savedState, ...req.body };
  saveState();
  res.json({ ok: true, state: savedState });
});

// Legacy routes (still supported but now backed by savedState)
app.get("/api/navaids", (req, res) => res.json(savedState.navaids));
app.get("/api/bash", (req, res) => res.json(savedState.bash));

app.listen(PORT, () => {
  console.log(`🚀 Backend listening on ${PORT}`);
});
