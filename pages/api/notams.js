import axios from "axios";
import https from "https";

export default async function handler(req, res) {
  const { icao } = req.query;
  const code = (icao || "KMGM").toUpperCase();

  let notams = [];

  try {
    const url = `https://www.notams.faa.gov/dinsQueryWeb/queryRetrievalMapAction.do?reportType=RAW&retrieveLocId=${code}&actionType=notamRetrievalByICAOs&formatType=DOMESTIC`;
    const agent = new https.Agent({ rejectUnauthorized: false });

    const r = await axios.get(url, {
      timeout: 20000,
      httpsAgent: agent,
      headers: {
        "User-Agent": "Mozilla/5.0",
        Accept: "text/html",
      },
    });

    console.log(`FAA NOTAM response length: ${r.data?.length}`);

    if (r.data) {
      const preBlocks = r.data.match(/<pre[^>]*>([\s\S]*?)<\/pre>/gi);

      if (preBlocks) {
        let i = 0;
        preBlocks.forEach((block) => {
          const text = block.replace(/<[^>]+>/g, "").trim();

          // Split into NOTAMs where they start with ! or FDC
          const notamBlocks = text.split(/\n(?=!|FDC)/);

          notamBlocks.forEach((ntm) => {
            const clean = ntm.replace(/\s*CREATED:.*$/i, "").trim();
            if (clean) {
              // classify severity
              let severity = "INFO";
              if (/RWY|RUNWAY|CLSD|CLOSED/.test(clean)) severity = "CRITICAL";
              else if (/TWY|TAXIWAY|OBST|OBSTRUCTION|RESTR/.test(clean))
                severity = "HIGH";
              else if (/ILS|VOR|GPS|LOC|NDB|TACAN|IAP|SID|STAR/.test(clean))
                severity = "MEDIUM";

              notams.push({
                id: i++,
                severity,
                text: clean,
              });
            }
          });
        });
      }
    }
  } catch (err) {
    console.error("❌ FAA NOTAM scraper failed:", err.message);
  }

  if (notams.length === 0) {
    console.warn(`⚠ No NOTAMs found for ${code}`);
    notams = [
      {
        id: 0,
        severity: "INFO",
        text: `⚠ Could not retrieve NOTAMs for ${code}. Check manually: https://notams.aim.faa.gov/notamSearch/search?designators=${code}`,
      },
    ];
  }

  // Sort by severity
  const priority = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, INFO: 3 };
  notams.sort((a, b) => priority[a.severity] - priority[b.severity]);

  res.status(200).json({ notams });
}
