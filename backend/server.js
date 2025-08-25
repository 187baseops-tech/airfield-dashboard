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

    // Per-request agent (ignore cert errors only for this request)
    const httpsAgent = new https.Agent({ rejectUnauthorized: false });

    const { data: html } = await axios.get(
      `https://ourairports.com/airports/${icao}/notams.html`,
      { httpsAgent }
    );

    const $ = cheerio.load(html);

    const results = [];
    // Look at all text nodes and catch any that start with NOTAM
    $("body *").each((i, el) => {
      const text = $(el).text().trim();
      if (text.startsWith("NOTAM") && (text.includes("KMGM") || text.includes("!MGM"))) {
        results.push({
          id: `notam-${i}`,
          text: cleanNotamText(text),
        });
      }
    });

    if (results.length === 0) {
      console.warn(`⚠️ OurAirports returned no ${icao} NOTAMs (maybe clear airfield)`);
    } else {
      console.log(
        "✅ Scraped NOTAMs sample:",
        results.slice(0, 3).map((n) => n.text)
      );
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

  // Replace long airport name with just (KMGM)
  cleaned = cleaned.replace(/Montgomery Regional.*?\(KMGM\)/gi, "(KMGM)");

  // Remove NOTAMN / NOTAMR keywords
  cleaned = cleaned.replace(/\bNOTAM[N,R]\b/g, "").trim();

  // Remove Q) section
  cleaned = cleaned.replace(/Q\)[\s\S]*?(?=A\))/g, "");

  // Keep A), B), C), E) but drop CREATED and SOURCE lines
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
  scrapeNotams("KMGM"); // Initial fetch
});
