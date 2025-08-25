import express from "express";
import cors from "cors";
import axios from "axios";
import solclientjs from "solclientjs";
import { parseStringPromise } from "xml2js";

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
      queueDescriptor: {
        type: solclientjs.QueueType.QUEUE,
        name: SWIM_QUEUE,
      },
    });

    consumer.on(solclientjs.MessageConsumerEventName.UP, () => {
      console.log("📡 MessageConsumer is UP and bound to queue.");
    });

    consumer.on(solclientjs.MessageConsumerEventName.MESSAGE, async msg => {
      try {
        // ✅ Safe payload extraction
        let xml = null;

        if (msg.getBinaryAttachment && msg.getBinaryAttachment()) {
          xml = msg.getBinaryAttachment().toString();
        }

        if (!xml && msg.getXmlContent) {
          xml = msg.getXmlContent();
        }

        if (!xml && msg.getTextAttachment) {
          xml = msg.getTextAttachment();
        }

        if (!xml && msg.getSdtContainer) {
          const sdt = msg.getSdtContainer();
          if (sdt) {
            try {
              xml = sdt.getXml();
            } catch {
              xml = JSON.stringify(sdt);
            }
          }
        }

        if (!xml) {
          console.warn("⚠️ SWIM message received with no usable payload type.");
          return;
        }

        // 🔍 Debug dump
        console.log("===== RAW NOTAM XML (first 500 chars) =====");
        console.log(xml.substring(0, 500));
        console.log("===========================================");

        const parsed = await parseStringPromise(xml, { explicitArray: true });
        console.log("PARSED ROOT KEYS:", Object.keys(parsed));

        // Placeholder parse (will refine after we see structure)
        const notam = parsed?.digitalNotam?.notam?.[0];
        if (!notam) return;

        const id = notam.$?.id || `NOTAM-${Date.now()}`;
        const text = notam.text?.[0] || "UNKNOWN NOTAM";
        const startTime = notam.startDateTime?.[0] || new Date().toISOString();
        const endTime =
          notam.endDateTime?.[0] ||
          new Date(Date.now() + 24 * 3600 * 1000).toISOString();

        if (text.includes("KMGM")) {
          activeNotams.push({
            id,
            text,
            startTime,
            endTime,
          });
          console.log("📨 Active NOTAM stored:", text);
        }
      } catch (err) {
        console.error("NOTAM parse error:", err);
      }
    });

    consumer.connect();
  });

  session.on(solclientjs.SessionEventCode.CONNECT_FAILED_ERROR, err => {
    console.error("❌ SWIM connection failed:", err);
  });

  session.connect();
}

connectToSwim();

// -------------------
// API Endpoints
// -------------------
app.get("/api/notams", (req, res) => {
  const { icao } = req.query;
  let results = activeNotams;

  if (icao) {
    results = activeNotams.filter(n =>
      n.text.includes(icao.toUpperCase())
    );
  }

  res.json({ notams: results });
});

app.get("/api/metar", async (req, res) => {
  const { icao } = req.query;
  if (!icao) return res.status(400).json({ error: "Missing ICAO code" });

  try {
    const url = `https://aviationweather.gov/api/data/metar?ids=${icao}&format=json`;
    const response = await axios.get(url);
    const data = response.data;

    if (data && data[0]) {
      res.json({ raw: data[0].rawOb || data[0].raw });
    } else {
      res.json({ raw: "" });
    }
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

    if (data && data[0]) {
      res.json({ raw: data[0].rawTAF || data[0].raw });
    } else {
      res.json({ raw: "" });
    }
  } catch (err) {
    console.error("TAF fetch error:", err.message);
    res.status(500).json({ error: "Failed to fetch TAF" });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Backend listening on port ${PORT}`);
});
