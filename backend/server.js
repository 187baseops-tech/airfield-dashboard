// backend/server.js

import "dotenv/config"; // Load .env file
import express from "express";
import { WebSocketServer } from "ws";
import solace from "solclientjs";
import { TextDecoder } from "util";
import xml2js from "xml2js";

// ----------------- DEBUG ENV -----------------
console.log("DEBUG ENV:", {
  SOLACE_HOST: process.env.SOLACE_HOST,
  SOLACE_VPN: process.env.SOLACE_VPN,
  SOLACE_USERNAME: process.env.SOLACE_USERNAME,
  SOLACE_PASSWORD: process.env.SOLACE_PASSWORD ? "***hidden***" : undefined,
  SWIM_QUEUE: process.env.SWIM_QUEUE,
});

// ----------------- Express Setup -----------------
const app = express();
const PORT = process.env.PORT || 5000;

app.get("/", (req, res) => {
  res.send("✅ FAA SWIM NOTAM Backend is running...");
});

const server = app.listen(PORT, () => {
  console.log(`🚀 Backend listening on port ${PORT}`);
});

// ----------------- WebSocket Setup -----------------
const wss = new WebSocketServer({ server });
let dashboardClients = [];

// In-memory store for active KMGM NOTAMs
// Map: NOTAM ID → { text, endTime }
const activeNotams = new Map();

wss.on("connection", (ws) => {
  console.log("📡 Frontend client connected");
  dashboardClients.push(ws);

  // Send current active NOTAMs immediately
  ws.send(
    JSON.stringify({
      type: "NOTAM_LIST",
      data: Array.from(activeNotams.values()).map((n) => n.text),
    })
  );

  ws.on("close", () => {
    console.log("❌ Client disconnected");
    dashboardClients = dashboardClients.filter((client) => client !== ws);
  });
});

function broadcastToDashboard(message) {
  dashboardClients.forEach((client) => {
    if (client.readyState === 1) {
      client.send(JSON.stringify(message));
    }
  });
}

// ----------------- Solace (FAA SWIM Queue) -----------------
const factoryProps = new solace.SolclientFactoryProperties();
factoryProps.profile = solace.SolclientFactoryProfiles.version10;
solace.SolclientFactory.init(factoryProps);

const sessionProps = {
  url: process.env.SOLACE_HOST,
  vpnName: process.env.SOLACE_VPN,
  userName: process.env.SOLACE_USERNAME,
  password: process.env.SOLACE_PASSWORD,
};

let session;
let messageConsumer;

function connectToSwim() {
  session = solace.SolclientFactory.createSession(sessionProps);

  session.on(solace.SessionEventCode.UP_NOTICE, () => {
    console.log("✅ Connected to FAA SWIM NOTAM feed");
    startQueueConsumer();
  });

  session.on(solace.SessionEventCode.CONNECT_FAILED_ERROR, (err) => {
    console.error("❌ Connection failed:", err);
  });

  session.on(solace.SessionEventCode.DISCONNECTED, () => {
    console.warn("⚠️ Disconnected from FAA SWIM, retrying in 10s...");
    setTimeout(connectToSwim, 10000);
  });

  try {
    session.connect();
  } catch (err) {
    console.error("❌ Error connecting to FAA SWIM:", err);
  }
}

function startQueueConsumer() {
  try {
    messageConsumer = session.createMessageConsumer({
      queueDescriptor: {
        name: process.env.SWIM_QUEUE,
        type: solace.QueueType.QUEUE,
      },
      acknowledgeMode: solace.MessageConsumerAcknowledgeMode.AUTO,
    });

    messageConsumer.on(solace.MessageConsumerEventName.UP, () => {
      console.log("📡 MessageConsumer is UP and bound to queue.");
    });

    messageConsumer.on(solace.MessageConsumerEventName.MESSAGE, async (message) => {
      try {
        // Decode XML
        let xml = "";
        if (message.getBinaryAttachment()) {
          const decoder = new TextDecoder("utf-8");
          xml = decoder.decode(message.getBinaryAttachment());
        }
        if (!xml) return;

        // Parse XML → JSON
        const parser = new xml2js.Parser({ explicitArray: false });
        const json = await parser.parseStringPromise(xml);

        const record = json?.notamRecord || {};
        const notam = record?.notam || {};

        // Extract key fields
        const id = notam?.notamId || "UNKNOWN/00";
        const location = notam?.location || "";
        const textField = notam?.notamText || "";
        const startTime = notam?.effectiveStart || "";
        const endTime = notam?.effectiveEnd || "";
        const created = notam?.created || "";
        const status = notam?.notamStatus || "ACTIVE";

        // Only KMGM + ACTIVE
        if (location === "KMGM" && status === "ACTIVE") {
          const formattedNotam = `${id} - ${textField} ${startTime ? startTime : ""} ${
            endTime ? "UNTIL " + endTime : ""
          }. CREATED: ${created}`;

          // Store with expiry
          activeNotams.set(id, { text: formattedNotam, endTime });
          console.log("✅ Active KMGM NOTAM stored:", formattedNotam);

          // Push to dashboard
          broadcastToDashboard({ type: "NOTAM_UPDATE", data: formattedNotam });
        }
      } catch (err) {
        console.error("⚠️ Error parsing NOTAM:", err);
      }
    });

    messageConsumer.connect();
  } catch (err) {
    console.error("❌ Error starting MessageConsumer:", err);
  }
}

// ----------------- Auto Cleanup for Expired NOTAMs -----------------
setInterval(() => {
  const now = new Date();
  for (const [id, notam] of activeNotams.entries()) {
    if (notam.endTime) {
      const expiry = new Date(notam.endTime);
      if (!isNaN(expiry.getTime()) && expiry < now) {
        activeNotams.delete(id);
        console.log(`⏰ NOTAM expired & removed: ${id}`);
        broadcastToDashboard({ type: "NOTAM_REMOVE", data: id });
      }
    }
  }
}, 5 * 60 * 1000); // every 5 minutes

// Start FAA connection
connectToSwim();
