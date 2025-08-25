import express from "express";
import axios from "axios";
import * as cheerio from "cheerio";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;

// ===== NOTAM SCRAPER (OurAirports) =====
async function scrapeNotams(icao) {
  try {
    console.log(`🌐 Scraping NOTAMs for ${icao} from OurAirports...`);
    const url = `https://ourairports.com/airports/${icao}/notams.html`;
    const { data: html } = await axios.get(url, { timeout: 15000 });
    const $ = cheerio.load(html);

    const notams = [];

    $("a[id^='notam-']").each((i, el) => {
      let text = $(el).text().trim();

      // Remove long "Montgomery Regional ..." names → leave (KMGM)
      text = text.replace(/Montgomery Regional \(Dannelly Field\) Airport\s*/gi, "").trim();

      // Hide NOTAMN/NOTAMR markers
      text = text.replace(/\sNOTAM[N|R]\s?/g, " ");

      // Cleanup spacing
      text = text.replace(/\s+/g, " ");

      // Keep ID (M0086/25, 08/030, etc.)
      const idMatch = text.match(/(M\d{4}\/\d{2}|\d{2}\/\d{3,4})/);
      const id = idMatch ? idMatch[0] : `notam-${i}`;

      notams.push({
        id,
        text,
      });
    });

    // Sort: closures, outages, then everything else
    notams.sort((a, b) => {
      const crit = (txt) =>
        /(CLSD|CLOSED|U\/S|UNSERVICEABLE|OUT OF SERVICE)/i.test(txt) ? 0 : 1;
      return crit(a.text) - crit(b.text);
    });

    console.log(`✅ Found ${notams.length} NOTAMs for ${icao}`);
    return notams;
  } catch (err) {
    console.error(`❌ OurAirports scraper failed: ${err.message}`);
    return [];
  }
}

// ===== API ROUTES =====
app.get("/api/notams", async (req, res) => {
  const icao = (req.query.icao || "KMGM").toUpperCase();
  const notams = await scrapeNotams(icao);
  res.json({ icao, notams });
});

// Example health route
app.get("/", (req, res) => {
  res.send("✅ Airfield Dashboard Backend is running.");
});

// ===== START SERVER =====
app.listen(PORT, () => {
  console.log(`🚀 Backend listening on port ${PORT}`);
  // Optional: fetch once on startup
  scrapeNotams("KMGM");
});
