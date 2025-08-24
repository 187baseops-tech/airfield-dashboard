import axios from "axios";

export default async function handler(req, res) {
  const { icao } = req.query;
  try {
    const url = `https://aviationweather.gov/api/data/taf?ids=${icao}&format=raw`;
    const r = await axios.get(url);
    const raw = (r.data || "").trim();

    res.status(200).json({ raw });
  } catch (err) {
    console.error("❌ TAF fetch failed:", err.message);
    res.status(500).json({ raw: "" });
  }
}
