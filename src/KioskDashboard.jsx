import { useState, useEffect, useRef } from "react";
import axios from "axios";
import {
  Stage,
  Layer,
  Rect,
  Arrow,
  Text as KText,
  Group,
  Label,
  Tag,
  Image as KonvaImage,
  Transformer,
} from "react-konva";

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

function computeFits(tempC) {
  const tempF = (tempC * 9) / 5 + 32;
  let level = "NORMAL";
  if (tempF >= 90 && tempF <= 101) level = "CAUTION";
  else if (tempF >= 102 && tempF <= 114) level = "DANGER";
  else if (tempF >= 115) level = "CANCEL";

  return { level, tempF: Math.round(tempF) };
}

// --- SlidesCard (read-only annotations) ---
function SlidesCard() {
  const [slides, setSlides] = useState([]);
  const [currentSlide, setCurrentSlide] = useState(0);
  const [annotations, setAnnotations] = useState({});
  const [isPlaying, setIsPlaying] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [imageObj, setImageObj] = useState(null);
  const trRef = useRef();

  const API =
    (typeof process !== "undefined" && process.env?.REACT_APP_API_URL)
      ? process.env.REACT_APP_API_URL
      : "https://airfield-dashboard.onrender.com";

  // Load slides list + annotations
  useEffect(() => {
    axios.get(`${API}/api/slides`).then((res) => setSlides(res.data));
    axios.get(`${API}/api/annotations`).then((res) =>
      setAnnotations(res.data.slides || {})
    );
  }, [API]);

  // Load current slide image
  useEffect(() => {
    if (!slides[currentSlide]) return;
    const img = new window.Image();
    img.src = `${API}/slides/${slides[currentSlide]}`;
    img.onload = () => setImageObj(img);
  }, [slides, currentSlide]);

  // Slideshow play
  useEffect(() => {
    if (isPlaying && slides.length > 0) {
      const interval = setInterval(
        () => setCurrentSlide((s) => (s + 1) % slides.length),
        5000
      );
      return () => clearInterval(interval);
    }
  }, [isPlaying, slides.length]);

  if (slides.length === 0) {
    return (
      <section className="border border-slate-700 rounded-lg p-3 flex flex-col h-[500px] md:col-span-2">
        <h2 className="text-lg font-bold underline mb-2">Airfield Slides</h2>
        <p className="text-sm text-slate-400">No slides available.</p>
      </section>
    );
  }

  const file = slides[currentSlide];
  const slideKey = file || "unknown";

  const SlideContainer = ({ children }) =>
    isFullscreen ? (
      <div className="fixed inset-0 z-50 bg-black flex flex-col">
        <div className="flex justify-between p-2 bg-slate-900 text-white relative z-50">
          <button
            onClick={() => setIsFullscreen(false)}
            className="px-3 py-1 bg-red-600 rounded"
          >
            ✖ Close
          </button>
        </div>
        <div className="flex-1 flex items-center justify-center overflow-auto">
          {children}
        </div>
      </div>
    ) : (
      <div className="relative flex-1 bg-slate-900 flex items-center justify-center rounded overflow-hidden h-[400px]">
        {children}
      </div>
    );

  return (
    <section className="border border-slate-700 rounded-lg p-3 flex flex-col md:col-span-2">
      <h2 className="text-lg font-bold underline mb-2">Airfield Slides</h2>

      {file && imageObj ? (
        <SlideContainer>
          <Stage
            width={isFullscreen ? window.innerWidth : 800}
            height={
              isFullscreen ? window.innerHeight - 50 : (imageObj.height * 800) / imageObj.width
            }
            className="absolute inset-0 w-full h-full"
          >
            <Layer>
              {/* Background slide image */}
              <KonvaImage
                image={imageObj}
                x={0}
                y={0}
                width={800}
                height={(imageObj.height * 800) / imageObj.width}
                listening={false}
              />

              {/* Existing annotations (read-only) */}
              {annotations[slideKey]?.map((a) => {
                if (a.type === "box") {
                  return <Rect key={a._id} x={a.x} y={a.y} width={a.w} height={a.h} stroke="red" />;
                } else if (a.type === "x") {
                  return <KText key={a._id} x={a.x} y={a.y} text="X" fontSize={32} fill="red" fontStyle="bold" />;
                } else if (a.type === "arrow") {
                  return (
                    <Arrow
                      key={a._id}
                      points={[a.x1, a.y1, a.x2, a.y2]}
                      stroke="green"
                      strokeWidth={4}
                      pointerLength={10}
                      pointerWidth={10}
                    />
                  );
                } else if (a.type === "text") {
                  return (
                    <KText
                      key={a._id}
                      x={a.x}
                      y={a.y}
                      text={a.text}
                      fontSize={16}
                      fill="white"
                    />
                  );
                }
                return null;
              })}
              <Transformer ref={trRef} rotateEnabled={false} resizeEnabled={false} enabledAnchors={[]} />
            </Layer>
          </Stage>
        </SlideContainer>
      ) : (
        <p className="text-slate-400">No slide selected.</p>
      )}

      {/* Controls */}
      <div className="flex flex-wrap justify-center gap-2 mt-3">
        <button onClick={() => setCurrentSlide((s) => (s - 1 + slides.length) % slides.length)} className="px-3 py-1 bg-slate-700 rounded">
          ⏮ Prev
        </button>
        <button onClick={() => setCurrentSlide((s) => (s + 1) % slides.length)} className="px-3 py-1 bg-slate-700 rounded">
          ⏭ Next
        </button>
        <button onClick={() => setIsPlaying(!isPlaying)} className="px-3 py-1 bg-slate-700 rounded">
          {isPlaying ? "⏸ Pause" : "▶ Play"}
        </button>
        <button onClick={() => setIsFullscreen(true)} className="px-3 py-1 bg-slate-700 rounded">
          ⛶ Enlarge
        </button>
      </div>
    </section>
  );
}

// --- Main Kiosk Dashboard ---
export default function KioskDashboard() {
  const ICAO = "KMGM";

  const [metar, setMetar] = useState("");
  const [taf, setTaf] = useState("");
  const [parsed, setParsed] = useState({});
  const [cat, setCat] = useState("VFR");
  const [fits, setFits] = useState({ level: "NORMAL", tempF: NaN });
  const [altReq, setAltReq] = useState(false);
  const [notams, setNotams] = useState([]);
  const [lastUpdate, setLastUpdate] = useState(new Date());

  const API =
    (typeof process !== "undefined" && process.env?.REACT_APP_API_URL)
      ? process.env.REACT_APP_API_URL
      : "https://airfield-dashboard.onrender.com";

  async function fetchMetarTaf() {
    try {
      const m = await axios.get(`${API}/api/metar?icao=${ICAO}`);
      const t = await axios.get(`${API}/api/taf?icao=${ICAO}`);
      setMetar(m.data.raw || "");
      setTaf(t.data.raw || "");
      setLastUpdate(new Date());
    } catch (err) {
      console.error("Fetch METAR/TAF error:", err);
    }
  }

  async function fetchNotams() {
    try {
      const n = await axios.get(`${API}/api/notams?icao=${ICAO}`);
      setNotams(n.data?.notams || []);
    } catch (err) {
      console.error("Fetch NOTAM error:", err);
    }
  }

  useEffect(() => {
    fetchMetarTaf();
    fetchNotams();

    const wxTimer = setInterval(fetchMetarTaf, 5 * 60 * 1000);
    const notamTimer = setInterval(fetchNotams, 15 * 60 * 1000);

    return () => {
      clearInterval(wxTimer);
      clearInterval(notamTimer);
    };
  }, []);

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
      setFits(computeFits(tC));
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
      <header className="flex flex-col items-center mb-4 text-center relative">
        <img
          src="/oss-patch.png"
          alt="187th OSS Patch"
          className="absolute top-0 left-0 w-20 h-20 md:w-28 md:h-28 object-contain m-2"
        />
        <h1 className="text-xl font-bold">
          187th Operations Support Squadron — {ICAO} Dannelly Field
        </h1>
        <p className="text-lg font-semibold">Airfield Dashboard — Kiosk Mode</p>
        <div className="text-sm mt-2">
          <p className="text-slate-400">
            Last Updated:{" "}
            {lastUpdate.toLocaleTimeString([], {
              hour12: false,
              hour: "2-digit",
              minute: "2-digit",
            })}
          </p>
        </div>
      </header>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-stretch">
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
                {Number.isFinite(fits.tempF) && `(${fits.tempF} °F Dry Bulb)`}
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
                <li
                  key={n.id}
                  className="p-2 rounded border border-slate-700 bg-slate-900"
                >
                  <pre className="font-mono whitespace-pre-wrap">{n.text}</pre>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-slate-400">No NOTAMs available.</p>
          )}
        </section>

        {/* Slides */}
        <SlidesCard />
      </div>
    </div>
  );
}
