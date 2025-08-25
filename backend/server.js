// server.js
import express from "express";
import cors from "cors";
import axios from "axios";
import solclientjs from "solclientjs";
import { parseStringPromise } from "xml2js";

const app = express();
const PORT = process.env.PORT || 5000;

// Enable CORS
app.use(cors());
app.use(express.json());

// -------------------
// Active NOTAM storage
// -------------------
let activeNotams = [];

// Cleanup expired NOTAMs every 5 min
setInterval(() => {
  const now = new Date();
  activeNotams = activeNotams.filter(n => new Date(n.endTime) > now);
  console.log("🧹 Cleaned expired NOTAMs, remaining:", activeNotams.length);
}, 5 * 60 * 1000);

// -------------------
// FAA SWIM Connection
// -------------------
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

    // Create flow bound to the NOTAM queue
    const flowProps = new solclientjs.FlowProperties();
    flowProps.flowStartState = true;
    flowProps.transportWindowSize = 10;
    flowProps.ackMode = solclientjs.MessageConsumerAckMode.CLIENT;
    flowProps.queueDescriptor = {
      type: solclientjs.QueueType.QUEUE,
      name: SWIM_QUEUE,
    };

    const consumer = session.createMessageConsumer(flowProps);
    consumer.on(solclientjs.MessageConsumerEventName.UP, () => {
      console.log("📡 MessageConsumer is UP and bound to queue.");
    });

    consumer.on(solclientjs.MessageConsumerEventName.MESSAGE, async msg => {
      try {
        const xml = msg.getBinaryAttachment().toString();
        const parsed = await parseStringPromise(xml);

        // Drill down to NOTAM text
        const notam = parsed?.digitalNotam?.notam?.[0];
        if (!notam) return;

        const id = notam.$?.id || `NOTAM-${Date.now()}`;
        const text = notam.text?.[0] || "UNKNOWN NOTAM";

        // Extract start/end times if available
        const startTime = notam.startDateTime?.[0] || new Date().toISOString();
        const endTime = notam.endDateTime?.[0] || new Date(Date.now() + 24 * 3600 * 1000).toISOString();

        // Only include KMGM + active NOTAMs
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

// NOTAMs
app.get("/api/notams", (req, res) => {
  res.json({ notams: activeNotams });
});

// METAR
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

// TAF
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

// -------------------
// Start server
// -------------------
app.listen(PORT, () => {
  console.log(`🚀 Backend listening on port ${PORT}`);
});
