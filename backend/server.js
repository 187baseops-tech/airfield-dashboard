import express from "express";
import axios from "axios";
import * as cheerio from "cheerio";
import cors from "cors";
import https from "https";
import fs from "fs";
import path from "path";
import solace from "solclientjs";
import { v4 as uuidv4 } from "uuid";

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

// ---- NOTAM Buffer (live from SWIM) ----
const notamsBuffer = [];

// ---- Init SWIM Solace Listener ----
function initSwimListener() {
  console.log("🌐 Initializing SWIM Solace listener...");

  const factoryProps = new solace.SolclientFactoryProperties();
  factoryProps.logLevel = solace.LogLevel.WARN;
  solace.SolclientFactory.init(factoryProps);

  const session = solace.SolclientFactory.createSession({
    url: process.env.SOLACE_HOST,
    vpnName: process.env.SOLACE_VPN,
    userName: process.env.SOLACE_USERNAME,
    password: process.env.SOLACE_PASSWORD,
  });

  session.on(solace.SessionEventCode.UP_NOTICE, () => {
    console.log("✅ Connected to FAA SWIM via Solace");

    // Create consumer for queue
    const consumer = session.createMessageConsumer({
      queueDescriptor: { name: process.env.SWIM_QUEUE, type: solace.QueueType.QUEUE },
      acknowledgeMode: solace.MessageConsumerAcknowledgeMode.AUTO,
    });

    consumer.on(solace.MessageConsumerEventName.UP, () => {
      console.log(`✅ Bound to SWIM queue: ${process.env.SWIM_QUEUE}`);
    });

    consumer.on(solace.MessageConsumerEventName.CONNECT_FAILED_ERROR, (err) => {
      console.error("❌ SWIM consumer connection failed:", err.infoStr || err);
    });

    consumer.on(solace.MessageConsumerEventName.DOWN, () => {
      console.warn("⚠ SWIM consumer went down, reconnecting...");
      setTimeout(() => consumer.connect(), 10000);
    });

    // ---- Message Handler ----
    consumer.on(solace.MessageConsumerEventName.MESSAGE, (message) => {
      try {
        let text = null;

        if (message.getBinaryAttachment()) {
          text = message.getBinaryAttachment().toString();
        } else if (message.getSdtContainer()) {
          text = message.getSdtContainer().getValue();
        } else if (message.getXmlContent()) {
          text = message.getXmlContent();
        }

        // Always log first 200 chars for debugging
        console.log("🔎 SWIM raw message preview:", (text || "").slice(0, 200));

        if (!text) {
          console.warn("⚠ Received SWIM message with no text payload. Dumping partial object:");
          console.log(JSON.stringify(message, null, 2).slice(0, 500));
          return;
        }

        let notamText = text;
        let notamId = uuidv4();

        if (text.startsWith("<")) {
          // crude XML -> string clean
          notamText = text.replace(/<[^>]+>/g, "").trim().slice(0, 500);
        } else {
          try {
            const json = JSON.parse(text);
            notamId = json.notamNumber || json.id || notamId;
            notamText = json.rawText || text;
          } catch {
            // leave as-is
          }
        }

        notamsBuffer.unshift({ id: notamId, text: notamText });
        if (notamsBuffer.length > 100) notamsBuffer.pop();

        console.log(`📥 New NOTAM from SWIM: ${notamId}`);
      } catch (err) {
        console.error("❌ Failed to parse SWIM message:", err.message);
      }
    });

    // Connect consumer
    consumer.connect();
  });

  session.on(solace.SessionEventCode.CONNECT_FAILED_ERROR, (e) => {
    console.error("❌ SWIM connection failed:", e.infoStr);
  });

  session.on(solace.SessionEventCode.DISCONNECTED, () => {
    console.warn("⚠ SWIM session disconnected, retrying in 10s...");
    setTimeout(initSwimListener, 10000);
  });

  session.connect();
}

initSwimListener();

// ---- OurAirports fallback scraper ----
async function fetchNotamsFallback(icao = "KMGM") {
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

      const id = header.slice(0, 20);
      notams.push({ id, text: `${id}\n${body}` });
    });

    console.log(`✅ Retrieved ${notams.length} NOTAMs from OurAirports`);
    return notams;
  } catch (err) {
    console.error("❌ Fallback OurAirports scrape failed:", err.message);
    return [];
  }
}

// ---- Routes ----
app.get("/", (req, res) => res.send("✅ Airfield Dashboard Backend running"));

// NOTAMs
app.get("/api/notams", async (req, res) => {
  if (notamsBuffer.length > 0) {
    console.log(`🚀 Serving ${notamsBuffer.length} NOTAMs from SWIM`);
    return res.json({ notams: notamsBuffer });
  }
  const icao = req.query.icao || "KMGM";
  const fallback = await fetchNotamsFallback(icao);
  res.json({ notams: fallback });
});

// Weather stubs
app.get("/api/metar", (req, res) => {
  const icao = req.query.icao || "KMGM";
  res.json({ raw: `${icao} 261553Z AUTO 00000KT 10SM CLR 30/18 A2992 RMK AO2` });
});
app.get("/api/taf", (req, res) => {
  const icao = req.query.icao || "KMGM";
  res.json({ raw: `${icao} 261730Z 2618/2718 18005KT P6SM SCT050 BKN200` });
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
  if (name && savedState.navaids[name] !== undefined) {
    savedState.navaids[name] = savedState.navaids[name] === "IN" ? "OUT" : "IN";
    saveState();
  }
  res.json({ navaids: savedState.navaids });
});
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
