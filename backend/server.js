import express from "express";
import axios from "axios";
import * as cheerio from "cheerio";
import cors from "cors";
import https from "https";
import fs from "fs";
import path from "path";
import solclientjs from "solclientjs";
import dotenv from "dotenv";

dotenv.config();

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

// ---- NOTAM Caches ----
let swimNotams = [];
let fallbackNotams = [];

// ---- SWIM (Solace) Setup ----
console.log("🌐 Initializing SWIM Solace listener...");
const factoryProps = new solclientjs.SolclientFactoryProperties();
factoryProps.profile = solclientjs.SolclientFactoryProfiles.version10;
solclientjs.SolclientFactory.init(factoryProps);

const session = solclientjs.SolclientFactory.createSession({
  url: process.env.SOLACE_HOST,
  vpnName: process.env.SOLACE_VPN,
  userName: process.env.SOLACE_USERNAME,
  password: process.env.SOLACE_PASSWORD,
  reconnectRetries: 5,
});

session.on(solclientjs.SessionEventCode.UP_NOTICE, () => {
  console.log("✅ Connected to FAA SWIM via Solace");

  const flowProps = new solclientjs.FlowProperties();
  flowProps.endpoint = { type: solclientjs.EndpointType.QUEUE, name: process.env.SWIM_QUEUE };
  flowProps.bind = true;

  const messageConsumer = session.createMessageConsumer(flowProps);
  messageConsumer.on(solclientjs.MessageConsumerEventName.MESSAGE, (msg) => {
    try {
      const text = msg.getSdtContainer().getXml();
      if (!text) return;

      const match = text.match(/<notamText>([\s\S]*?)<\/notamText>/i);
      if (match) {
        const rawText = match[1].trim();
        if (/KMGM/i.test(rawText)) {
          const idMatch = rawText.match(/!KMGM\s+(\d{2}\/\d{3,4})/);
          const id = idMatch ? idMatch[1] : `KMGM-${Date.now()}`;
          const notam = { id, text: rawText };
          swimNotams = [notam, ...swimNotams].slice(0, 50);
          console.log(`✅ SWIM NOTAM added for KMGM: ${id}`);
        }
      }
    } catch (err) {
      console.error("❌ Failed to parse SWIM message:", err.message);
    }
  });

  messageConsumer.on(solclientjs.MessageConsumerEventName.DOWN, () =>
    console.warn("⚠ SWIM consumer down")
  );
  messageConsumer.connect();
  console.log(`✅ Bound to SWIM queue: ${process.env.SWIM_QUEUE}`);
});

session.on(solclientjs.SessionEventCode.CONNECT_FAILED_ERROR, () =>
  console.error("❌ SWIM connection failed")
);
session.on(solclientjs.SessionEventCode.DISCONNECTED, () =>
  console.warn("⚠ SWIM disconnected")
);
session.connect();

// ---- OurAirports Fallback ----
async function fetchFallbackNotams(icao = "KMGM") {
  try {
    console.log(`🌐 Scraping OurAirports for ${icao}...`);
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
      const match = header.match(/(M?\d{3,4}\/\d{2}|!\w{3}\s+\d{2}\/\d{3,4}|FDC\s*\d{1,4}\/\d{2})/);
      const id = match ? match[0] : header.slice(0, 20);
      const lines = body.split("\n").map((l) => l.trim()).filter(Boolean);
      notams.push({ id, text: `${id}\n${lines.join("\n")}` });
    });
    fallbackNotams = notams;
    console.log(`✅ Retrieved ${notams.length} NOTAMs from OurAirports`);
  } catch (err) {
    console.error("❌ OurAirports NOTAM fetch failed:", err.message);
    fallbackNotams = [];
  }
}
setInterval(() => fetchFallbackNotams("KMGM"), 15 * 60 * 1000);
fetchFallbackNotams("KMGM");

// ---- Routes ----
app.get("/", (req, res) => res.send("✅ Airfield Dashboard Backend running"));

// NOTAMs
app.get("/api/notams", (req, res) => {
  const icao = req.query.icao || "KMGM";
  if (icao !== "KMGM") return res.json({ notams: [] });
  if (swimNotams.length > 0) {
    res.json({ notams: swimNotams });
  } else {
    res.json({ notams: fallbackNotams });
  }
});

// ✅ METAR (NOAA plain text)
app.get("/api/metar", async (req, res) => {
  const icao = req.query.icao || "KMGM";
  try {
    const { data } = await axios.get(
      `https://aviationweather.gov/api/data/metar?ids=${icao}&format=raw&taf=false`
    );
    const firstLine = data.split("\n").find((line) => line.startsWith(icao)) || `${icao} NIL`;
    res.json({ raw: firstLine.trim() });
  } catch (err) {
    console.error("❌ METAR fetch failed:", err.message);
    res.json({ raw: `${icao} NIL` });
  }
});

// ✅ TAF (NOAA plain text)
app.get("/api/taf", async (req, res) => {
  const icao = req.query.icao || "KMGM";
  try {
    const { data } = await axios.get(
      `https://aviationweather.gov/api/data/taf?ids=${icao}&format=raw`
    );
    const tafLines = data.split("\n").filter((line) => line.startsWith(icao));
    res.json({ raw: tafLines.join("\n").trim() || `${icao} NIL` });
  } catch (err) {
    console.error("❌ TAF fetch failed:", err.message);
    res.json({ raw: `${icao} NIL` });
  }
});

// State persistence
app.get("/api/state", (req, res) => res.json(savedState));
app.post("/api/state", (req, res) => {
  savedState = { ...savedState, ...req.body };
  saveState();
  res.json({ ok: true, state: savedState });
});

// NAVAIDs + BASH
app.get("/api/navaids", (req, res) => res.json(savedState.navaids));
app.get("/api/bash", (req, res) => res.json(savedState.bash));

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
