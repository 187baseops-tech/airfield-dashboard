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
  navaids: { mgm: "IN", mxf: "IN", ils10: "IN", ils28: "OUT" },
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

// ---- NOTAM Scraper ----
async function fetchNotams(icao = "KMGM") {
  try {
    console.log(`🌐 Scraping NOTAMs for ${icao}...`);
    const httpsAgent = new https.Agent({ rejectUnauthorized: false });
    const { data: html } = await axios.get(
      `https://ourairports.com/airports/${icao}/notams.html`,
      { httpsAgent }
    );

    const $ = cheerio.load(html);
    let notams = [];

    // --- Primary Parse: <section id="notam-...">
    $("section[id^=notam-]").each((_, el) => {
      const header = $(el).find("h3").text().trim();
      const body = $(el).find("p.notam").text().trim();
      if (!header || !body) return;

      // Extract NOTAM ID
      const match = header.match(
        /(M?\d{3,4}\/\d{2}|!\w{3}\s+\d{2}\/\d{3,4}|FDC\s*\d{1,4}\/\d{2})/
      );
      const id = match ? match[0] : header.slice(0, 20);

      // Always append ICAO (KMGM)
      const locMatch = header.match(/\(KMGM\)/);
      const location = locMatch ? " (KMGM)" : "";

      // Clean body lines
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

    // --- Fallback Parse: Regex if no NOTAMs found
    if (notams.length === 0) {
      console.warn("⚠️ Section parse failed, falling back to regex mode...");
      const lines = html.split("\n");
      let currentNotam = null;

      for (const line of lines) {
        const text = line.trim();
        if (!text) continue;

        if (/^(NOTAM|M\d{3,4}\/\d{2}|!\w{3}|FDC)/.test(text)) {
          if (currentNotam) notams.push(currentNotam);

          const match = text.match(
            /(M?\d{3,4}\/\d{2}|!\w{3}\s+\d{2}\/\d{3,4}|FDC\s*\d{1,4}\/\d{2})/
          );
          const id = match ? match[0] : text.slice(0, 20);

          currentNotam = { id, text };
        } else if (currentNotam) {
          if (!text.startsWith("CREATED:") && !text.startsWith("SOURCE:")) {
            currentNotam.text += "\n" + text;
          }
        }
      }
      if (currentNotam) notams.push(currentNotam);
    }

    // --- Sort by Criticality
    const score = (n) => {
      const t = n.text.toUpperCase();
      if (t.includes("CLSD") || t.includes("U/S") || t.includes("UNSERVICEABLE") || t.includes("OUT OF SERVICE")) return 1;
      if (t.includes("OBST") || t.includes("OBSTACLE") || t.includes("CRANE") || t.includes("TOWER")) return 2;
      return 3;
    };
    notams.sort((a, b) => score(a) - score(b));

    console.log(`✅ Returning ${notams.length} NOTAMs for ${icao}`);
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
  const notams = await fetchNotams(icao);
  res.json({ notams });
});

// Weather stubs
app.get("/api/metar", (req, res) => {
  const icao = req.query.icao || "KMGM";
  res.json({ raw: `${icao} 251755Z AUTO 00000KT 10SM CLR 30/18 A2992 RMK AO2` });
});
app.get("/api/taf", (req, res) => {
  const icao = req.query.icao || "KMGM";
  res.json({ raw: `${icao} 251730Z 2518/2618 18005KT P6SM SCT050 BKN200` });
});

// State persistence
app.get("/api/state", (req, res) => res.json(savedState));
app.post("/api/state", (req, res) => {
  savedState = { ...savedState, ...req.body };
  saveState();
  res.json({ ok: true, state: savedState });
});

// NAVAIDs + BASH helpers
app.get("/api/navaids", (req, res) => res.json(savedState.navaids));

app.post("/api/navaids", (req, res) => {
  const { name } = req.body;
  if (!name || !Object.prototype.hasOwnProperty.call(savedState.navaids, name)) {
    return res.status(400).json({ ok: false, error: "Invalid NAVAID name" });
  }

  // Cycle IN ↔ OUT
  savedState.navaids[name] =
    savedState.navaids[name] === "IN" ? "OUT" : "IN";

  saveState();
  res.json({ ok: true, navaids: savedState.navaids });
});

app.get("/api/bash", (req, res) => res.json(savedState.bash));

// Slides + Annotations
app.use("/slides", express.static(SLIDES_DIR));

app.get("/api/slides", (req, res) => {
  try {
    console.log("📂 Checking slide directory:", SLIDES_DIR);

    if (!fs.existsSync(SLIDES_DIR)) {
      console.log("❌ Slides directory not found");
      return res.json([]);
    }

    const files = fs.readdirSync(SLIDES_DIR);
    console.log("📂 Files found in slides dir:", files);

    const images = files.filter((f) => /\.(png|jpg|jpeg)$/i.test(f));
    console.log("🖼️ Returning images:", images);

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
