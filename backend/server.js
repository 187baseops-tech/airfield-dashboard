import express from "express";
import axios from "axios";
import * as cheerio from "cheerio";
import https from "https";
import cors from "cors";
import bodyParser from "body-parser";

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(bodyParser.json());

// =======================
// NOTAM CLEANUP HELPER
// =======================
function cleanNotam(raw) {
  if (!raw) return "";

  raw = raw.replace(/Montgomery Regional \(Dannelly Field\) Airport\s*/gi, "(KMGM)");
  raw = raw.replace(/\bNOTAMN\b/g, "");
  raw = raw.replace(/\bNOTAMR\b/g, "");
  raw = raw.replace(/NOTAMS @ OurAirports[\s\S]*?NOTAM source.*?\n/gi, "");

  const lines = raw.split("\n").map(l => l.trim());
  const filtered = lines.filter(l =>
    l.match(/^\w{1}\d{4}\/\d{2}/) || // ID e.g. M0086/25
    l.startsWith("A)") ||
    l.startsWith("B)") ||
    l.startsWith("C)") ||
    l.startsWith("E)")
  );

  return filtered.join("\n").trim();
}

// =======================
// SCRAPE OURAIRPORTS
// =======================
async function scrapeOurAirports(icao) {
  try {
    const url = `https://ourairports.com/airports/${icao}/notams.html`;
    const res = await axios.get(url, {
      httpsAgent: new https.Agent({ rejectUnauthorized: false }) // bypass SSL issues
    });

    const $ = cheerio.load(res.data);
    const notams = [];

    $(".notam, a[href*='notam-']").each((_, el) => {
      const text = $(el).text().trim();
      const cleaned = cleanNotam(text);
      if (cleaned) {
        notams.push({ id: Date.now() + Math.random(), text: cleaned });
      }
    });

    return notams;
  } catch (err) {
    console.error("❌ OurAirports scraper failed:", err.message);
    return [];
  }
}

// =======================
// ROUTES
// =======================
app.get("/api/notams", async (req, res) => {
  const icao = (req.query.icao || "KMGM").toUpperCase();
  console.log(`🌐 Scraping NOTAMs for ${icao} from OurAirports...`);
  const notams = await scrapeOurAirports(icao);
  if (notams.length === 0) {
    console.warn(`⚠️ No NOTAMs found for ${icao}`);
  }
  res.json({ notams });
});

// Dummy METAR + TAF for now
app.get("/api/metar", async (req, res) => {
  res.json({ raw: "KMGM 251953Z 18008KT 10SM CLR 32/21 A2992" });
});
app.get("/api/taf", async (req, res) => {
  res.json({ raw: "KMGM 251720Z 2518/2618 18010KT P6SM SCT040" });
});

// Dummy NAVAIDs
let navaids = { mgm: true, mxf: true, ils: true };
app.get("/api/navaids", (req, res) => res.json(navaids));

// =======================
// START SERVER
// =======================
app.listen(PORT, () => {
  console.log(`🚀 Backend listening on port ${PORT}`);
});
