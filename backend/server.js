// server.js
import express from "express";
import axios from "axios";
import * as cheerio from "cheerio";
import https from "https";

const app = express();
const PORT = process.env.PORT || 10000;

// --- In-memory store ---
let notams = [];

// --- Helper: scrape NOTAMs from OurAirports ---
async function scrapeNotams(icao) {
  try {
    console.log(`🌐 Scraping NOTAMs for ${icao} from OurAirports...`);

    // Per-request agent (ignores cert errors only for this request)
    const httpsAgent = new https.Agent({ rejectUnauthorized: false });

    const { data: html } = await axios.get(
      `https://ourairports.com/airports/${icao}/notams.html`,
      { httpsAgent }
    );

    const $ = cheerio.load(html);

    const results = [];
    $("a[id^=notam-]").each((i, el) => {
      const text = $(el).text().trim();

      // Only include ICAO NOTAMs
      if (text.includes(icao)) {
        results.push({
          id: $(el).attr("id"),
          text: cleanNotamText(text),
        });
      }
    });

    if (results.length === 0) {
      console.warn(`⚠️ OurAirports returned no ${icao} NOTAMs (maybe clear airfield)`);
    }

    notams = results;
    return results;
  } catch (err) {
    console.error(`❌ OurAirports scraper failed: ${err.message}`);
    return [];
  }
}

// --- Clean up raw NOTAM text ---
function cleanNotamText(raw) {
  let cleaned = raw;

  // Strip "Montgomery Regional..." keep only (KMGM)
  cleaned = cleaned.replace(/Montgomery Regional.*?\(KMGM\)/gi, "(KMGM)");

  // Remove "NOTAMN" or "NOTAMR" keywords
  cleaned = cleaned.replace(/\bNOTAM[N,R]\b/g, "").trim();

  // Strip leading "Q) ..." section
  cleaned = cleaned.replace(/Q\)[\s\S]*?(?=A\))/g, "");

  // Keep A), B), C), E), remove "CREATED" and "SOURCE"
  cleaned = cleaned
    .replace(/CREATED:.*$/gm, "")
    .replace(/SOURCE:.*$/gm, "")
    .trim();

  return cleaned;
}

// --- Routes ---
app.get("/api/notams", async (req, res) => {
  const icao = (req.query.icao || "KMGM").toUpperCase();
  const data = await scrapeNotams(icao);
  res.json({ notams: data });
});

// Health check
app.get("/", (req, res) => {
  res.send("✅ Airfield Dashboard backend is running.");
});

// --- Start server ---
app.listen(PORT, () => {
  console.log(`🚀 Backend listening on port ${PORT}`);
  scrapeNotams("KMGM"); // Fetch initial NOTAMs
});
