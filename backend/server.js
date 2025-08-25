import express from "express";
import cors from "cors";
import axios from "axios";
import solclientjs from "solclientjs";
import { parseStringPromise } from "xml2js";
import https from "https";
import * as cheerio from "cheerio";

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

let activeNotams = [];
let navaidsStatus = {
  ils10: true,
  ils28: true,
  mgm: true,  // TACAN MGM
  mxf: true   // TACAN MXF
};

// -------------------------
// Cleanup expired NOTAMs
// -------------------------
setInterval(() => {
  const now = new Date();
  const before = activeNotams.length;
  activeNotams = activeNotams.filter(n => new Date(n.endTime) > now);

  if (activeNotams.length !== before) {
    // Reset everything to green
    navaidsStatus = { ils10: true, ils28: true, mgm: true, mxf: true };
    // Reapply NOTAM effects
    activeNotams.forEach(n => updateNavaidsFromNotam(n));
  }

  console.log("🧹 Cleaned expired NOTAMs, remaining:", activeNotams.length);
}, 5 * 60 * 1000);

// -------------------------
// Env Vars
// -------------------------
const {
  SOLACE_HOST,
  SOLACE_VPN,
  SOLACE_USERNAME,
  SOLACE_PASSWORD,
  SWIM_QUEUE,
} = process.env;

solclientjs.SolclientFactory.init({
  profile: solclientjs.SolclientFactoryProfiles.version10,
});

// -------------------------
// Helper: Clean NOTAM text
// -------------------------
function cleanNotamText(raw) {
  let text = raw;

  text = text.replace(/^.*?(NOTAM\s)/s, "$1"); // Remove junk before NOTAM
  text = text.replace(/\([^)]*KMGM[^)]*\)/gi, "(KMGM)"); // Replace long airport names
  text = text.replace(/\bNOTAM[NRC]\b/gi, ""); // Remove NOTAMN/R/C
  text = text.replace(/Q\)[^\n]+/gi, "").trim(); // Remove Q lines
  text = text.replace(/^.*?(?=A\))/s, "").trim(); // Keep A/B/C onwards
  text = text.replace(/CREATED:[^\n]+/gi, "").trim(); // Remove CREATED
  text = text.replace(/SOURCE:[^\n]+/gi, "").trim();  // Remove SOURCE
  text = text.replace(/\s+/g, " ").trim(); // Collapse spaces

  return text;
}

// -------------------------
// Helper: NOTAM priority
// -------------------------
function notamPriority(text) {
  const critical = ["CLOSURE", "CLSD", "UNSERVICEABLE", "U/S", "CLOSED"];
  const high = ["OBSTACLE", "OBSTN", "WORK IN PROGRESS", "WIP"];
  const medium = ["LIGHT OUT", "LGT U/S", "MARKING", "PAINT", "BIRD"];

  const upper = text.toUpperCase();

  if (critical.some(k => upper.includes(k))) return 1;
  if (high.some(k => upper.includes(k))) return 2;
  if (medium.some(k => upper.includes(k))) return 3;
  return 4;
}

// -------------------------
// Helper: Update NAVAIDs
// -------------------------
function updateNavaidsFromNotam(notam) {
  const txt = notam.text.toUpperCase();

  if (/ILS\s*10.*U\/S|ILS RWY 10.*UNSERVICEABLE/.test(txt)) navaidsStatus.ils10 = false;
  if (/ILS\s*28.*U\/S|ILS RWY 28.*UNSERVICEABLE/.test(txt)) navaidsStatus.ils28 = false;
  if (/MGM.*TACAN.*U\/S/.test(txt)) navaidsStatus.mgm = false;
  if (/MXF.*TACAN.*U\/S/.test(txt)) navaidsStatus.mxf = false;
}

// -------------------------
// Scraper: Baseline NOTAMs
// -------------------------
async function fetchBaselineNotams() {
  try {
    console.log("🌐 Scraping baseline NOTAMs for KMGM from OurAirports...");

    const agent = new https.Agent({ rejectUnauthorized: false });
    const url = "https://ourairports.com/airports/KMGM/notams.html";

    const res = await axios.get(url, {
      httpsAgent: agent,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; AirfieldDashboard/1.0)" },
    });

    const html = res.data;
    const $ = cheerio.load(html);

    let notamDivs = $("div[class*='notam'], div[class*='NOTAM']");

    if (notamDivs.length === 0) {
      console.warn("⚠️ Cheerio found no <div class='notam'> elements. Falling back to regex...");
      const fallbackMatches = html.match(/NOTAM[\s\S]*?(?=<\/div>|<\/p>)/gi) || [];

      fallbackMatches.forEach((block, idx) => {
        const raw = block.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
        const cleaned = cleanNotamText(raw);

        if (cleaned.length > 0) {
          const notam = {
            id: `BASE-${Date.now()}-${idx}`,
            icao: "KMGM",
            text: cleaned,
            startTime: new Date().toISOString(),
            endTime: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
          };
          activeNotams.push(notam);
          updateNavaidsFromNotam(notam);
        }
      });

      console.log(`✅ Loaded ${activeNotams.length} baseline KMGM NOTAMs (regex fallback)`);
    } else {
      notamDivs.each((idx, el) => {
        const raw = $(el).text().replace(/\s+/g, " ").trim();
        const cleaned = cleanNotamText(raw);

        if (cleaned.length > 0) {
          const notam = {
            id: `BASE-${Date.now()}-${idx}`,
            icao: "KMGM",
            text: cleaned,
            startTime: new Date().toISOString(),
            endTime: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
          };
          activeNotams.push(notam);
          updateNavaidsFromNotam(notam);
        }
      });
      console.log(`✅ Loaded ${activeNotams.length} baseline KMGM NOTAMs from OurAirports`);
    }
  } catch (err) {
    console.error("❌ OurAirports scraper failed:", err.message);
  }
}

// -------------------------
// SWIM live feed
// -------------------------
function connectToSwim() {
  const session = solclientjs.SolclientFactory.createSession({
    url: SOLACE_HOST,
    vpnName: SOLACE_VPN,
    userName: SOLACE_USERNAME,
    password: SOLACE_PASSWORD,
  });

  session.on(solclientjs.SessionEventCode.UP_NOTICE, () => {
    console.log("✅ Connected to FAA SWIM NOTAM feed");

    const ackMode =
      solclientjs.MessageConsumerAcknowledgementMode?.CLIENT ||
      solclientjs.MessageConsumerAckMode?.CLIENT ||
      solclientjs.MessageConsumerAckMode?.AUTO;

    const consumer = session.createMessageConsumer({
      flowStartState: true,
      transportWindowSize: 10,
      ackMode,
      queueDescriptor: { type: solclientjs.QueueType.QUEUE, name: SWIM_QUEUE },
    });

    consumer.on(solclientjs.MessageConsumerEventName.UP, () => {
      console.log("📡 MessageConsumer is UP and bound to queue.");
    });

    consumer.on(solclientjs.MessageConsumerEventName.MESSAGE, async (msg) => {
      try {
        let xml = null;
        if (msg.getBinaryAttachment && msg.getBinaryAttachment()) {
          xml = msg.getBinaryAttachment().toString();
        }
        if (!xml && msg.getXmlContent) xml = msg.getXmlContent();
        if (!xml && msg.getTextAttachment) xml = msg.getTextAttachment();

        if (!xml) {
          console.warn("⚠️ SWIM message with no payload");
          return;
        }

        const textRaw = xml.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
        const cleaned = cleanNotamText(textRaw);

        const icao = cleaned.includes("KMGM") ? "KMGM" : "UNKNOWN";

        if (icao === "KMGM") {
          const notam = {
            id: Date.now().toString(),
            icao,
            text: cleaned,
            startTime: new Date().toISOString(),
            endTime: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
          };
          activeNotams.push(notam);
          updateNavaidsFromNotam(notam);
          console.log(`📨 Stored KMGM NOTAM:`, cleaned.substring(0, 100));
        } else {
          console.log("ℹ️ Ignored non-KMGM NOTAM");
        }
      } catch (err) {
        console.error("NOTAM parse error:", err);
      }
    });

    consumer.connect();
  });

  session.on(solclientjs.SessionEventCode.CONNECT_FAILED_ERROR, (err) => {
    console.error("❌ SWIM connection failed:", err);
  });

  session.connect();
}

// -------------------------
// Startup
// -------------------------
(async () => {
  await fetchBaselineNotams();
  connectToSwim();
})();

// -------------------------
// API Endpoints
// -------------------------
app.get("/api/notams", (req, res) => {
  let results = activeNotams
    .filter(n => n.icao === "KMGM" || n.text.includes("KMGM"))
    .sort((a, b) => notamPriority(a.text) - notamPriority(b.text));

  res.json({ notams: results });
});

app.get("/api/navaids", (req, res) => {
  res.json(navaidsStatus);
});

app.get("/api/metar", async (req, res) => {
  const { icao } = req.query;
  if (!icao) return res.status(400).json({ error: "Missing ICAO code" });

  try {
    const url = `https://aviationweather.gov/api/data/metar?ids=${icao}&format=json`;
    const response = await axios.get(url);
    const data = response.data;
    res.json({ raw: data?.[0]?.rawOb || data?.[0]?.raw || "" });
  } catch (err) {
    console.error("METAR fetch error:", err.message);
    res.status(500).json({ error: "Failed to fetch METAR" });
  }
});

app.get("/api/taf", async (req, res) => {
  const { icao } = req.query;
  if (!icao) return res.status(400).json({ error: "Missing ICAO code" });

  try {
    const url = `https://aviationweather.gov/api/data/taf?ids=${icao}&format=json`;
    const response = await axios.get(url);
    const data = response.data;
    res.json({ raw: data?.[0]?.rawTAF || data?.[0]?.raw || "" });
  } catch (err) {
    console.error("TAF fetch error:", err.message);
    res.status(500).json({ error: "Failed to fetch TAF" });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Backend listening on port ${PORT}`);
});
