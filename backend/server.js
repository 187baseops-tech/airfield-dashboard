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

// Cleanup expired NOTAMs every 5 min
setInterval(() => {
  const now = new Date();
  activeNotams = activeNotams.filter(n => new Date(n.endTime) > now);
  console.log("🧹 Cleaned expired NOTAMs, remaining:", activeNotams.length);
}, 5 * 60 * 1000);

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

// ---------------------------------------
// Helper: clean NOTAM text
// ---------------------------------------
function cleanNotamText(raw) {
  let text = raw;

  // Remove Q) lines
  text = text.replace(/Q\)[^\n]+/gi, "").trim();

  // Strip any leading junk before the first "A)"
  text = text.replace(/^.*?(?=A\))/s, "").trim();

  // Remove CREATED: lines
  text = text.replace(/CREATED:[^\n]+/gi, "").trim();

  // Remove SOURCE: lines
  text = text.replace(/SOURCE:[^\n]+/gi, "").trim();

  // Collapse whitespace
  text = text.replace(/\s+/g, " ").trim();

  return text;
}

// ---------------------------------------
// Scraper: Fetch baseline NOTAMs from OurAirports
// ---------------------------------------
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
        const rawNotam = block.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
        const cleaned = cleanNotamText(rawNotam);

        if (cleaned.length > 0) {
          activeNotams.push({
            id: `BASE-${Date.now()}-${idx}`,
            icao: "KMGM",
            text: cleaned,
            startTime: new Date().toISOString(),
            endTime: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
          });
        }
      });

      console.log(`✅ Loaded ${activeNotams.length} baseline KMGM NOTAMs (regex fallback)`);
    } else {
      notamDivs.each((idx, el) => {
        const rawNotam = $(el).text().replace(/\s+/g, " ").trim();
        const cleaned = cleanNotamText(rawNotam);

        if (cleaned.length > 0) {
          activeNotams.push({
            id: `BASE-${Date.now()}-${idx}`,
            icao: "KMGM",
            text: cleaned,
            startTime: new Date().toISOString(),
            endTime: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
          });
        }
      });
      console.log(`✅ Loaded ${activeNotams.length} baseline KMGM NOTAMs from OurAirports`);
    }
  } catch (err) {
    console.error("❌ OurAirports scraper failed:", err.message);
  }
}

// ---------------------------------------
// SWIM Live Connection
// ---------------------------------------
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
          console.warn("⚠️ SWIM message received with no usable payload.");
          return;
        }

        await parseStringPromise(xml).catch(() => {});

        const id = Date.now().toString();
        const icaoMatch = xml.match(/\b[A-Z]{4}\b/);
        const icao = icaoMatch ? icaoMatch[0] : "UNKNOWN";

        const textRaw = xml.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
        const cleaned = cleanNotamText(textRaw);

        if (icao === "KMGM" || cleaned.includes("KMGM")) {
          const startTime = new Date().toISOString();
          const endTime = new Date(Date.now() + 24 * 3600 * 1000).toISOString();

          activeNotams.push({ id, icao, text: cleaned, startTime, endTime });
          console.log(`📨 Stored KMGM NOTAM:`, cleaned.substring(0, 120));
        } else {
          console.log(`ℹ️ Ignored non-KMGM NOTAM (ICAO=${icao})`);
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

// ---------------------------------------
// Initialize
// ---------------------------------------
(async () => {
  await fetchBaselineNotams();
  connectToSwim();
})();

// -------------------
// API Endpoints
// -------------------
app.get("/api/notams", (req, res) => {
  let results = activeNotams.filter(
    (n) => n.icao === "KMGM" || n.text.includes("KMGM")
  );

  res.json({ notams: results });
});

app.get("/api/metar", async (req, res) => {
  const { icao } = req.query;
  if (!icao) return res.status(400).json({ error: "Missing ICAO code" });

  try {
    const url = `https://aviationweather.gov/api/data/metar?ids=${icao}&format=json`;
    const response = await axios.get(url);
    const data = response.data;

    if (data && data[0]) res.json({ raw: data[0].rawOb || data[0].raw });
    else res.json({ raw: "" });
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

    if (data && data[0]) res.json({ raw: data[0].rawTAF || data[0].raw });
    else res.json({ raw: "" });
  } catch (err) {
    console.error("TAF fetch error:", err.message);
    res.status(500).json({ error: "Failed to fetch TAF" });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Backend listening on port ${PORT}`);
});
