// server.js
import express from "express";
import axios from "axios";
import * as cheerio from "cheerio";
import cors from "cors";
import https from "https";

const app = express();
const PORT = process.env.PORT || 10000;

// ✅ Enable CORS so frontend can reach backend
app.use(cors());
app.use(express.json());

// ---- NOTAM Scraper (OurAirports) ----
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

      // Clean up text
      const cleaned = text
        .replace(/Montgomery Regional.*?\(KMGM\)/gi, "(KMGM)")
        .replace(/\s?NOTAMN/g, "")
        .trim();

      const match = cleaned.match(/(M?\d{3,4}\/\d{2}|\d{2}\/\d{3,4})/);
      const id = match ? match[0] : cleaned.slice(0, 12);

      notams.push({ id, text: cleaned });
    });

    console.log("✅ Scraped NOTAMs sample:", notams.slice(0, 3));
    return notams;
  } catch (err) {
    console.error("❌ OurAirports scraper failed:", err.message);
    return [];
  }
}

// ---- API Routes ----
app.get("/", (req, res) => {
  res.send("✅ Airfield Dashboard Backend is running");
});

// NOTAMs
app.get("/api/notams", async (req, res) => {
  const icao = req.query.icao || "KMGM";
  const notams = await fetchNotams(icao);
  res.json({ notams });
});

// Weather stub
app.get("/api/metar", (req, res) => {
  const icao = req.query.icao || "KMGM";
  res.json({ raw: `${icao} 251755Z AUTO 00000KT 10SM CLR 30/18 A2992 RMK AO2` });
});

app.get("/api/taf", (req, res) => {
  const icao = req.query.icao || "KMGM";
  res.json({
    raw: `${icao} 251730Z 2518/2618 18005KT P6SM SCT050 BKN200`,
  });
});

// NAVAIDs stub
app.get("/api/navaids", (req, res) => {
  res.json({ mgm: true, mxf: true });
});

// BASH stub
app.get("/api/bash", (req, res) => {
  res.json({ north: "LOW", south: "LOW" });
});

// ---- Start server ----
app.listen(PORT, () => {
  console.log(`🚀 Backend listening on port ${PORT}`);
});
