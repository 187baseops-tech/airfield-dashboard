import express from "express";
import axios from "axios";
import * as cheerio from "cheerio";
import solclientjs from "solclientjs";

// --- Config ---
const PORT = process.env.PORT || 10000;
const ICAO = "KMGM";

const app = express();
app.use(express.json());

// --- In-Memory Store ---
let notams = [];
let navaids = { mgm: true, mxf: true }; // example toggles

// --- Helper: Clean NOTAM text ---
function cleanNotam(text) {
  if (!text) return null;

  // Remove OurAirports headers/footers
  text = text
    .replace(/NOTAMS? @ OurAirports[\s\S]*?Airport/gi, "")
    .replace(/Toggle navigation[\s\S]*?Help/gi, "")
    .replace(/NOTAM feed for Montgomery[\s\S]*?rss">/gi, "")
    .replace(/NOTAM source[\s\S]*$/gi, "")
    .trim();

  // Strip "NOTAMN" / "NOTAMR"
  text = text.replace(/\bNOTAM[NR]\b/g, "").trim();

  // Ensure only NOTAMs survive
  if (!/^(M\d{3,4}\/\d{2}|NOTAM \d{2}\/\d{3}|!\w{3})/i.test(text)) {
    return null;
  }

  return text;
}

// --- Scrape Baseline NOTAMs from OurAirports ---
async function scrapeBaselineNotams() {
  console.log(`🌐 Scraping NOTAMs for ${ICAO} from OurAirports...`);
  try {
    const url = `https://ourairports.com/airports/${ICAO}/notams.html`;
    const res = await axios.get(url, { timeout: 15000, httpsAgent: new (require("https").Agent)({ rejectUnauthorized: false }) });

    const $ = cheerio.load(res.data);
    const scraped = [];

    $(".notam, a[href*='notam-']").each((_, el) => {
      const raw = $(el).text().trim();
      const cleaned = cleanNotam(raw);
      if (cleaned) {
        scraped.push({ id: Date.now() + Math.random(), text: cleaned });
      }
    });

    if (scraped.length === 0) {
      console.warn(`⚠️ OurAirports returned no ${ICAO} NOTAMs`);
    } else {
      notams = scraped;
      console.log(`✅ Stored ${scraped.length} NOTAMs for ${ICAO}`);
    }
  } catch (err) {
    console.error(`❌ OurAirports scraper failed: ${err.message}`);
  }
}

// --- API Endpoints ---
app.get("/api/notams", (req, res) => {
  res.json({ notams });
});

app.get("/api/navaids", (req, res) => {
  res.json(navaids);
});

// --- Startup ---
app.listen(PORT, () => {
  console.log(`🚀 Backend listening on port ${PORT}`);
  scrapeBaselineNotams();
  setInterval(scrapeBaselineNotams, 15 * 60 * 1000); // refresh every 15min
});
