import { useState, useEffect, useRef } from "react";
import axios from "axios";

// --- Helpers ---
function highlightTaf(rawTaf) {
  if (!rawTaf) return "--";

  return rawTaf
    .replace(/(BKN|OVC)(\d{3})/g, (match, layer, height) => {
      const h = parseInt(height, 10) * 100;
      if (h <= 1500) {
        return `<span class="font-bold text-red-500">${layer}${height}</span>`;
      }
      return match;
    })
    .replace(/(\d{1,2}(?: \d\/\d)?SM)/g, (m) => {
      const miles = parseVisibility(m);
      if (!isNaN(miles) && miles < 3) {
        return `<span class="font-bold text-red-500">${m}</span>`;
      }
      return m;
    });
}

function parseMetar(raw) {
  if (!raw) return {};
  const wind = raw.match(/(\d{3}|VRB)(\d{2})(G\d{2})?KT/);
  const vis = raw.match(/(\d{1,2}(?: \d\/\d)?SM)/);
  const alt = raw.match(/A(\d{4})/);
  const temp = raw.match(/ (M?\d{2})\/(M?\d{2}) /);
  const ceiling = raw.match(/ (FEW|SCT|BKN|OVC)(\d{3})/);

  return {
    wind: wind ? wind[0] : "--",
    vis: vis ? vis[1] : "--",
    altimeter: alt ? `A${alt[1]}` : "--",
    tempdew: temp ? temp[0].trim() : "--",
    ceiling: ceiling ? `${ceiling[1]}${ceiling[2]}` : "SKC",
  };
}

function parseVisibility(visStr) {
  if (!visStr) return NaN;
  const parts = visStr.replace("SM", "").trim().split(" ");
  let total = 0;
  for (const part of parts) {
    if (part.includes("/")) {
      const [num, denom] = part.split("/").map(Number);
      total += num / denom;
    } else {
      total += Number(part);
    }
  }
  return total;
}

function flightCat(ceiling, vis) {
  if (ceiling < 500 || vis < 1) return "LIFR";
  if (ceiling < 1000 || vis < 3) return "IFR";
  if (ceiling < 3000 || vis < 5) return "MVFR";
  return "VFR";
}

function computeFits(tempC, dewC) {
  const tempF = (tempC * 9) / 5 + 32;
  const dewF = (dewC * 9) / 5 + 32;

  const twbF = dewF + 0.36 * (tempF - dewF);
  const wbgt = 0.7 * twbF + 0.3 * tempF;

  let level = "NORMAL";
  if (wbgt >= 90 && wbgt <= 101) level = "CAUTION";
  else if (wbgt >= 102 && wbgt <= 114) level = "DANGER";
  else if (wbgt >= 115) level = "CANCEL";

  return { level, wbgt: Math.round(wbgt) };
}
// --- SlidesCard ---
function SlidesCard() {
  const [slides, setSlides] = useState([]);
  const [currentSlide, setCurrentSlide] = useState(0);
  const [annotations, setAnnotations] = useState({});
  const [tool, setTool] = useState(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const svgRef = useRef();

  const API = process.env.REACT_APP_API_URL;

  useEffect(() => {
    axios.get(`${API}/api/slides`).then(res => setSlides(res.data));
    axios.get(`${API}/api/annotations`).then(res => setAnnotations(res.data.slides || {}));
  }, [API]);

  useEffect(() => {
    if (isPlaying && slides.length > 0) {
      const interval = setInterval(() => {
        setCurrentSlide(s => (s + 1) % slides.length);
      }, 5000);
      return () => clearInterval(interval);
    }
  }, [isPlaying, slides.length]);

  const saveAnnotations = (updated) => {
    setAnnotations(updated);
    axios.post(`${API}/api/annotations`, { slides: updated });
  };

  const prevSlide = () => setCurrentSlide(s => (s - 1 + slides.length) % slides.length);
  const nextSlide = () => setCurrentSlide(s => (s + 1) % slides.length);

  const handleClick = (e) => {
    if (!tool || slides.length === 0) return;
    const rect = svgRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const file = slides[currentSlide];
    const slideKey = file;
    const annots = { ...annotations };
    if (!annots[slideKey]) annots[slideKey] = [];
    if (tool === "x") annots[slideKey].push({ type: "x", x, y });
    else if (tool === "text") {
      const text = prompt("Enter note:");
      if (text) annots[slideKey].push({ type: "text", x, y, text });
    }
    saveAnnotations(annots);
  };

  const handleDragStart = (e) => {
    if (!tool || slides.length === 0) return;
    const rect = svgRef.current.getBoundingClientRect();
    svgRef.current.dataset.startX = e.clientX - rect.left;
    svgRef.current.dataset.startY = e.clientY - rect.top;
  };

  const handleDragEnd = (e) => {
    if (!tool || slides.length === 0) return;
    const rect = svgRef.current.getBoundingClientRect();
    const x2 = e.clientX - rect.left;
    const y2 = e.clientY - rect.top;
    const x1 = parseFloat(svgRef.current.dataset.startX);
    const y1 = parseFloat(svgRef.current.dataset.startY);
    const file = slides[currentSlide];
    const slideKey = file;
    const annots = { ...annotations };
    if (!annots[slideKey]) annots[slideKey] = [];
    if (tool === "box") {
      annots[slideKey].push({
        type: "box",
        x: Math.min(x1, x2),
        y: Math.min(y1, y2),
        w: Math.abs(x2 - x1),
        h: Math.abs(y2 - y1)
      });
    } else if (tool === "arrow") {
      annots[slideKey].push({ type: "arrow", x1, y1, x2, y2 });
    }
    saveAnnotations(annots);
  };

  const clearAnnotations = () => {
    if (slides.length === 0) return;
    const file = slides[currentSlide];
    const slideKey = file;
    const annots = { ...annotations, [slideKey]: [] };
    saveAnnotations(annots);
  };

  if (slides.length === 0) {
    return (
      <section className="border border-slate-700 rounded-lg p-3 flex flex-col h-[500px] md:col-span-2">
        <h2 className="text-lg font-bold underline mb-2">Airfield Slides</h2>
        <p className="text-sm text-slate-400">No slides available.</p>
      </section>
    );
  }

  const file = slides[currentSlide];
  const slideKey = file;

  const viewer = (
    <div className="relative flex-1 bg-slate-900 flex items-center justify-center rounded overflow-hidden h-full">
      <img
        src={`${API}/slides/${file}`} 
        alt="Slide"
        className="object-contain max-h-full max-w-full"
      />
      <svg
        ref={svgRef}
        className="absolute inset-0 w-full h-full"
        onClick={handleClick}
        onMouseDown={handleDragStart}
        onMouseUp={handleDragEnd}
      >
        <defs>
          <marker
            id="arrowhead"
            markerWidth="10"
            markerHeight="7"
            refX="10"
            refY="3.5"
            orient="auto"
          >
            <polygon points="0 0, 10 3.5, 0 7" fill="green" />
          </marker>
        </defs>
        {annotations[slideKey]?.map((a, i) => {
          if (a.type === "box")
            return (
              <rect
                key={i}
                x={a.x}
                y={a.y}
                width={a.w}
                height={a.h}
                className="stroke-red-600 fill-transparent"
              />
            );
          if (a.type === "x")
            return (
              <text key={i} x={a.x} y={a.y} fontSize="32" fill="red" fontWeight="bold">
                X
              </text>
            );
          if (a.type === "arrow")
            return (
              <line
                key={i}
                x1={a.x1}
                y1={a.y1}
                x2={a.x2}
                y2={a.y2}
                stroke="green"
                strokeWidth="4"
                markerEnd="url(#arrowhead)"
              />
            );
          if (a.type === "text")
            return (
              <foreignObject key={i} x={a.x} y={a.y} width="200" height="50">
                <div
                  className="px-1 text-sm font-bold text-white bg-black border border-red-600 rounded"
                  style={{ display: "inline-block", maxWidth: "180px", wordWrap: "break-word" }}
                >
                  {a.text}
                </div>
              </foreignObject>
            );
          return null;
        })}
      </svg>
    </div>
  );

  return (
    <>
      {/* Card View */}
      {!isFullscreen && (
        <section className="border border-slate-700 rounded-lg p-3 flex flex-col md:col-span-2">
          <h2 className="text-lg font-bold underline mb-2 flex justify-between items-center">
            Airfield Slides
            <button
              onClick={() => setIsFullscreen(true)}
              className="px-2 py-1 bg-slate-700 rounded text-sm"
            >
              🔎 Expand
            </button>
          </h2>

          <div className="relative bg-slate-900 flex items-center justify-center rounded overflow-hidden h-[500px]">
            <img
              src={`${API}/slides/${file}`} 
              alt="Slide"
              className="absolute inset-0 w-full h-full object-contain"
            />
            <svg
              ref={svgRef}
              className="absolute inset-0 w-full h-full"
              onClick={handleClick}
              onMouseDown={handleDragStart}
              onMouseUp={handleDragEnd}
            >
              {/* Annotation rendering same as above */}
            </svg>
          </div>
        </section>
      )}

      {/* Fullscreen View */}
      {isFullscreen && (
        <div className="fixed inset-0 z-50 bg-black bg-opacity-95 flex flex-col">
          <div className="flex justify-between items-center p-3 text-white">
            <h2 className="text-lg font-bold">Airfield Slides</h2>
            <button
              onClick={() => setIsFullscreen(false)}
              className="px-2 py-1 bg-red-600 rounded"
            >
              ❌ Close
            </button>
          </div>
          <div className="flex-1 flex items-center justify-center">{viewer}</div>
        </div>
      )}
    </>
  );
}
// --- Main Dashboard ---
export default function Dashboard() {
  const ICAO = "KMGM";

  const [metar, setMetar] = useState("");
  const [taf, setTaf] = useState("");
  const [parsed, setParsed] = useState({});
  const [cat, setCat] = useState("VFR");
  const [fits, setFits] = useState({ level: "NORMAL", wbgt: NaN });
  const [altReq, setAltReq] = useState(false);
  const [altICAO, setAltICAO] = useState("");
  const [notams, setNotams] = useState([]);
  const [expandedNotams, setExpandedNotams] = useState({});
  const [lastUpdate, setLastUpdate] = useState(new Date());

  // --- Airfield Toggles ---
  const [activeRunway, setActiveRunway] = useState("10");
  const [rsc, setRsc] = useState("DRY");
  const [rscNotes, setRscNotes] = useState("");
  const [barriers, setBarriers] = useState({ east: "DOWN", west: "DOWN" });
  const [navaids, setNavaids] = useState({});
  const [arff, setArff] = useState("GREEN");
  const [bash, setBash] = useState({ NORTH: "LOW", SOUTH: "LOW" });

  const API = process.env.REACT_APP_API_URL;

  // --- Fetch METAR/TAF/NOTAMs ---
  async function fetchData() {
    try {
      const m = await axios.get(`${API}/api/metar?icao=${ICAO}`);
      const t = await axios.get(`${API}/api/taf?icao=${ICAO}`);
      const n = await axios.get(`${API}/api/notams?icao=${ICAO}`);
      setMetar(m.data.rawOb || m.data.raw || "");
      setTaf(t.data.rawTAF || t.data.raw || "");
      setNotams(n.data?.notams || []);
      setLastUpdate(new Date());
    } catch (err) {
      console.error("Fetch error:", err);
    }
  }

  // --- Fetch NAVAIDs (auto synced from backend) ---
  async function fetchNavaids() {
    try {
      const res = await axios.get(`${API}/api/navaids`);
      setNavaids(res.data);
    } catch (err) {
      console.error("Failed to fetch NAVAIDs:", err.message);
    }
  }

  useEffect(() => {
    fetchData();
    fetchNavaids();
    const timer = setInterval(() => {
      fetchData();
      fetchNavaids();
    }, 300000); // every 5 min
    return () => clearInterval(timer);
  }, []);

  // --- Process METAR/TAF ---
  useEffect(() => {
    const p = parseMetar(metar);
    setParsed(p);

    const visMiles = parseVisibility(p.vis);
    const ceilFt =
      p.ceiling && /^(BKN|OVC)\d{3}/.test(p.ceiling)
        ? parseInt(p.ceiling.match(/\d{3}/)[0]) * 100
        : 99999;
    setCat(flightCat(ceilFt, visMiles));

    const tempMatch = p.tempdew?.match(/(M?\d{2})\/(M?\d{2})/);
    if (tempMatch) {
      const tC = parseInt(tempMatch[1].replace("M", "-"));
      const tdC = parseInt(tempMatch[2].replace("M", "-"));
      setFits(computeFits(tC, tdC));
    }

    let altNeeded = false;
    if (
      p.ceiling &&
      /^(BKN|OVC)\d{3}/.test(p.ceiling) &&
      ceilFt <= 1500 &&
      visMiles < 3
    ) {
      altNeeded = true;
    }
    setAltReq(altNeeded);
  }, [metar, taf]);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 p-4">
      {/* Header */}
      <header className="flex flex-col items-center mb-4 text-center">
        <h1 className="text-xl font-bold">
          187th Operations Support Squadron — {ICAO} Dannelly Field
        </h1>
        <p className="text-lg font-semibold">Airfield Dashboard</p>
        <div className="text-sm mt-2">
          <p>{new Date().toLocaleString()}</p>
          <p>Zulu: {new Date().toUTCString()}</p>
          <p className="text-slate-400">
            Last Updated: {lastUpdate.toLocaleString()}
          </p>
          <button
            onClick={() => {
              fetchData();
              fetchNavaids();
            }}
            className="mt-1 px-3 py-1 bg-blue-600 hover:bg-blue-500 rounded"
          >
            🔄 Refresh
          </button>
        </div>
      </header>

      {/* First Row */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-stretch">
        {/* Airfield Status */}
        <section className="border border-slate-700 rounded-lg p-3 flex flex-col h-[500px]">
          <h2 className="text-lg font-bold underline mb-2">Airfield Status</h2>

          {/* Active Runway */}
          <div className="mb-2">
            <p className="font-semibold">Active Runway</p>
            <button
              className="px-3 py-1 rounded bg-green-600"
              onClick={() =>
                setActiveRunway(activeRunway === "10" ? "28" : "10")
              }
            >
              {activeRunway}
            </button>
          </div>

          {/* RSC */}
          <div className="mb-2">
            <p className="font-semibold">RSC</p>
            <div className="flex gap-2">
              <button
                className={`px-3 py-1 rounded ${
                  rsc === "DRY"
                    ? "bg-green-600"
                    : rsc === "WET"
                    ? "bg-red-600"
                    : "bg-slate-700"
                }`}
                onClick={() =>
                  setRsc(
                    rsc === "DRY"
                      ? "WET"
                      : rsc === "WET"
                      ? "N/A"
                      : "DRY"
                  )
                }
              >
                {rsc}
              </button>
              <input
                type="text"
                placeholder="Notes"
                value={rscNotes}
                onChange={(e) => setRscNotes(e.target.value)}
                className="flex-1 px-2 py-1 rounded bg-slate-900 border border-slate-600 text-sm"
              />
            </div>
          </div>

          {/* Barriers */}
          <div className="mb-2">
            <p className="font-semibold">Barriers</p>
            <div className="flex gap-2 flex-wrap">
              {["east", "west"].map((side) => (
                <button
                  key={side}
                  className={`px-2 py-1 rounded ${
                    barriers[side] === "UNSERVICEABLE"
                      ? "bg-red-600"
                      : "bg-green-600"
                  }`}
                  onClick={() =>
                    setBarriers((prev) => ({
                      ...prev,
                      [side]:
                        prev[side] === "DOWN"
                          ? "UP"
                          : prev[side] === "UP"
                          ? "UNSERVICEABLE"
                          : "DOWN",
                    }))
                  }
                >
                  {side.toUpperCase()} BAK-12 {barriers[side]}
                </button>
              ))}
            </div>
          </div>

          {/* NAVAIDs (Auto Synced) */}
          <div className="mb-2">
            <p className="font-semibold">NAVAIDs</p>
            <div className="flex gap-2 flex-wrap">
              {Object.keys(navaids).map((n) => (
                <div
                  key={n}
                  className={`px-2 py-1 rounded ${
                    navaids[n] ? "bg-green-600" : "bg-red-600"
                  }`}
                >
                  {n === "mgm"
                    ? "MGM TACAN"
                    : n === "mxf"
                    ? "MXF TACAN"
                    : n.toUpperCase()}
                </div>
              ))}
            </div>
          </div>

          {/* ARFF */}
          <div className="mb-2">
            <p className="font-semibold">ARFF</p>
            <button
              className={`px-3 py-1 rounded ${
                arff === "GREEN"
                  ? "bg-green-600"
                  : arff === "YELLOW"
                  ? "bg-yellow-500"
                  : "bg-red-600"
              }`}
              onClick={() =>
                setArff(
                  arff === "GREEN"
                    ? "YELLOW"
                    : arff === "YELLOW"
                    ? "RED"
                    : "GREEN"
                )
              }
            >
              ARFF {arff}
            </button>
          </div>
        </section>

        {/* Weather */}
        <section className="border border-slate-700 rounded-lg p-3 flex flex-col h-[500px]">
          <div className="flex items-center gap-2 mb-2">
            <h2 className="text-lg font-bold underline">WEATHER</h2>
            <span
              className={`px-3 py-1 rounded-full text-lg font-bold ${
                cat === "VFR"
                  ? "bg-green-600"
                  : cat === "MVFR"
                  ? "bg-blue-600"
                  : cat === "IFR"
                  ? "bg-red-600"
                  : "bg-fuchsia-700"
              }`}
            >
              {cat}
            </span>
            {altReq && (
              <span className="px-3 py-1 rounded-full text-lg font-bold bg-red-600">
                ⚠ ALT REQ
              </span>
            )}
          </div>

          {altReq && (
            <input
              type="text"
              placeholder="Enter Alternate ICAO"
              value={altICAO}
              onChange={(e) => setAltICAO(e.target.value.toUpperCase())}
              className="w-full px-2 py-1 rounded bg-slate-900 border border-slate-600 text-sm font-bold text-red-500 mb-2"
            />
          )}

          <div className="grid grid-cols-2 gap-2 text-sm mb-2">
            <div>Winds: {parsed.wind}</div>
            <div>Vis: {parsed.vis}</div>
            <div>Ceiling: {parsed.ceiling}</div>
            <div>Altimeter: {parsed.altimeter}</div>
            <div>Temp/Dew: {parsed.tempdew}</div>
            <div>
              FITS:{" "}
              <span
                className={`ml-1 font-bold ${
                  fits.level === "NORMAL"
                    ? "text-green-400"
                    : fits.level === "CAUTION"
                    ? "text-yellow-400"
                    : fits.level === "DANGER"
                    ? "text-orange-500"
                    : "text-red-600"
                }`}
              >
                {fits.level}{" "}
                {Number.isFinite(fits.wbgt) && `(${fits.wbgt} °F WBGT)`}
              </span>
            </div>
          </div>

          <div className="mt-2 flex-1 overflow-y-auto">
            <p className="text-xs text-slate-400">Raw METAR</p>
            <pre className="bg-slate-900 p-2 rounded text-sm whitespace-pre-wrap break-words">
              {metar || "--"}
            </pre>
            <p className="text-xs text-slate-400">Raw TAF</p>
            <pre
              className="bg-slate-900 p-2 rounded text-sm whitespace-pre-wrap break-words"
              dangerouslySetInnerHTML={{ __html: highlightTaf(taf) }}
            />
          </div>
        </section>

        {/* NOTAMs */}
<section className="border border-slate-700 rounded-lg p-3 flex flex-col h-[500px]">
  <h2 className="text-lg font-bold underline mb-2">KMGM NOTAMs</h2>
  {notams.length > 0 ? (
    <ul className="space-y-2 text-sm flex-1 overflow-y-auto">
      {notams.map((n) => (
        <li key={n.id} className="p-2 rounded border border-slate-700 bg-slate-900">
          <pre className="font-mono whitespace-pre-wrap">{n.text}</pre>
        </li>
      ))}
    </ul>
  ) : (
    <p className="text-sm text-slate-400">No NOTAMs available.</p>
  )}
</section>
      </div>

      {/* Second Row */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-stretch mt-4">
        {/* BASH Forecast */}
        <section className="border border-slate-700 rounded-lg p-3 flex flex-col h-[500px] md:col-span-1">
          <h2 className="text-lg font-bold underline mb-2">BASH Forecast</h2>
          <div className="flex flex-col gap-2">
            {Object.keys(bash).map((loc) => (
              <button
                key={loc}
                className={`px-3 py-1 rounded font-bold ${
                  bash[loc] === "LOW"
                    ? "bg-green-600"
                    : bash[loc] === "MODERATE"
                    ? "bg-yellow-500 text-black"
                    : "bg-red-600"
                }`}
                onClick={() =>
                  setBash((prev) => ({
                    ...prev,
                    [loc]:
                      prev[loc] === "LOW"
                        ? "MODERATE"
                        : prev[loc] === "MODERATE"
                        ? "SEVERE"
                        : "LOW",
                  }))
                }
              >
                {loc}: {bash[loc]}
              </button>
            ))}
          </div>
        </section>

        {/* Airfield Slides */}
        <SlidesCard />
      </div>
    </div>
  );
}
