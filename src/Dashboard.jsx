import { useState, useEffect, useRef } from "react";
import axios from "axios";
import {
  Stage,
  Layer,
  Rect,
  Arrow,
  Text as KText,
  Transformer,
  Group,
  Label,
  Tag,
  Image as KonvaImage,
} from "react-konva";
import { v4 as uuidv4 } from "uuid";

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

function computeCrosswind(metarWind, activeRunway) {
  if (!metarWind || metarWind === "--") return null;

  const match = metarWind.match(/(\d{3}|VRB)(\d{2})/);
  if (!match) return null;

  let dir = match[1] === "VRB" ? null : parseInt(match[1]);
  const spd = parseInt(match[2]);

  if (!spd) return null;

  const runwayHeading = activeRunway === "10" ? 100 : 280;
  if (dir === null) return { crosswind: spd, warning: spd >= 25 };

  let rel = dir - runwayHeading;
  if (rel > 180) rel -= 360;
  if (rel < -180) rel += 360;

  const cross = Math.round(spd * Math.sin((rel * Math.PI) / 180));
  return { crosswind: cross, warning: Math.abs(cross) >= 25 };
}
function SlidesCard() {
  const [slides, setSlides] = useState([]);
  const [currentSlide, setCurrentSlide] = useState(0);
  const [annotations, setAnnotations] = useState({});
  const [tool, setTool] = useState(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [selectedId, setSelectedId] = useState(null);
  const [drawing, setDrawing] = useState(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const trRef = useRef();

  const API =
    (typeof process !== "undefined" && process.env?.REACT_APP_API_URL)
      ? process.env.REACT_APP_API_URL
      : "https://one87oss-airfield-dashboard.onrender.com";

  // load slides + annotations
  useEffect(() => {
    axios.get(`${API}/api/slides`).then((res) => setSlides(res.data));
    axios.get(`${API}/api/annotations`).then((res) =>
      setAnnotations(res.data.slides || {})
    );
  }, [API]);

  // autoplay
  useEffect(() => {
    if (isPlaying && slides.length > 0) {
      const interval = setInterval(
        () => setCurrentSlide((s) => (s + 1) % slides.length),
        5000
      );
      return () => clearInterval(interval);
    }
  }, [isPlaying, slides.length]);

  const saveAnnotations = (updated) => {
    setAnnotations(updated);
    axios.post(`${API}/api/annotations`, { slides: updated });
  };

  const addAnnotation = (annot) => {
    const file = slides[currentSlide];
    if (!file) return;
    const slideKey = file;
    const annots = { ...annotations };
    if (!annots[slideKey]) annots[slideKey] = [];
    annots[slideKey].push({ _id: uuidv4(), ...annot });
    saveAnnotations(annots);
  };

  const updateAnnotation = (id, newAttrs) => {
    const file = slides[currentSlide];
    if (!file) return;
    const slideKey = file;
    const annots = { ...annotations };
    annots[slideKey] = annots[slideKey].map((a) =>
      a._id === id ? { ...a, ...newAttrs } : a
    );
    saveAnnotations(annots);
  };

  const deleteAnnotation = (id) => {
    const file = slides[currentSlide];
    if (!file) return;
    const slideKey = file;
    const annots = { ...annotations };
    annots[slideKey] = annots[slideKey].filter((a) => a._id !== id);
    saveAnnotations(annots);
    setSelectedId(null);
    trRef.current?.nodes([]);
  };

  const clearAllAnnotations = () => {
    const file = slides[currentSlide];
    if (!file) return;
    const slideKey = file;
    const annots = { ...annotations };
    annots[slideKey] = [];
    saveAnnotations(annots);
    setSelectedId(null);
    trRef.current?.nodes([]);
  };

  useEffect(() => {
    if (trRef.current && selectedId) {
      const shape = trRef.current.getStage().findOne(`#${selectedId}`);
      if (shape) {
        trRef.current.nodes([shape]);
        trRef.current.getLayer().batchDraw();
      }
    }
  }, [selectedId, annotations]);

  if (slides.length === 0) {
    return (
      <section className="border border-slate-700 rounded-lg p-3 flex flex-col h-[500px] md:col-span-2">
        <h2 className="text-lg font-bold underline mb-2">Airfield Slides</h2>
        <p className="text-sm text-slate-400">No slides available.</p>
      </section>
    );
  }

  const file = slides[currentSlide] || null;
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
          <button
            onClick={() => clearAllAnnotations()}
            className="px-3 py-1 bg-yellow-600 rounded"
          >
            🧹 Clear All
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

      {file ? (
        <SlideContainer>
          <Stage
            width={isFullscreen ? window.innerWidth : 800}
            height={isFullscreen ? window.innerHeight - 50 : 400}
            className="absolute inset-0 w-full h-full"
            onMouseDown={(e) => {
              if (!tool || e.target !== e.target.getStage()) return;
              const pos = e.target.getStage().getPointerPosition();
              if (!pos) return;

              if (tool === "box") {
                setDrawing({ type: "box", x: pos.x, y: pos.y, w: 0, h: 0 });
              } else if (tool === "arrow") {
                setDrawing({
                  type: "arrow",
                  x1: pos.x,
                  y1: pos.y,
                  x2: pos.x,
                  y2: pos.y,
                });
              } else if (tool === "x") {
                addAnnotation({ type: "x", x: pos.x, y: pos.y });
              } else if (tool === "text") {
                const text = prompt("Enter note:");
                if (text) addAnnotation({ type: "text", x: pos.x, y: pos.y, text });
              }
            }}
            onMouseMove={(e) => {
              if (!drawing) return;
              const pos = e.target.getStage().getPointerPosition();
              if (!pos) return;

              if (drawing.type === "box") {
                setDrawing({
                  ...drawing,
                  w: pos.x - drawing.x,
                  h: pos.y - drawing.y,
                });
              } else if (drawing.type === "arrow") {
                setDrawing({ ...drawing, x2: pos.x, y2: pos.y });
              }
            }}
            onMouseUp={() => {
              if (drawing) {
                addAnnotation(drawing);
                setDrawing(null);
              }
            }}
          >
            <Layer>
              {/* Background slide image rendered via Konva */}
              <KonvaImage
                image={(() => {
                  const img = new window.Image();
                  img.src = `${API}/slides/${file}`;
                  return img;
                })()}
                x={0}
                y={0}
                width={isFullscreen ? window.innerWidth : 800}
                height={isFullscreen ? window.innerHeight - 50 : 400}
              />

              {/* Draw annotations */}
              {annotations[slideKey]?.map((a) => {
                const commonProps = {
                  key: a._id,
                  id: a._id,
                  draggable: true,
                  onClick: () => setSelectedId(a._id),
                  onTap: () => setSelectedId(a._id),
                  onDragEnd: (e) =>
                    updateAnnotation(a._id, {
                      x: e.target.x(),
                      y: e.target.y(),
                    }),
                };

                let shape;
                if (a.type === "box") {
                  shape = (
                    <Rect {...commonProps} x={a.x} y={a.y} width={a.w} height={a.h} stroke="red" />
                  );
                } else if (a.type === "x") {
                  shape = (
                    <KText
                      {...commonProps}
                      x={a.x}
                      y={a.y}
                      text="X"
                      fontSize={32}
                      fill="red"
                      fontStyle="bold"
                    />
                  );
                } else if (a.type === "arrow") {
                  shape = (
                    <Arrow
                      {...commonProps}
                      points={[a.x1, a.y1, a.x2, a.y2]}
                      stroke="green"
                      strokeWidth={4}
                      pointerLength={10}
                      pointerWidth={10}
                    />
                  );
                } else if (a.type === "text") {
                  shape = (
                    <KText
                      {...commonProps}
                      x={a.x}
                      y={a.y}
                      text={a.text}
                      fontSize={16}
                      fill="white"
                      background="black"
                    />
                  );
                }

                return (
                  <Group key={a._id}>
                    {shape}
                    {selectedId === a._id && (
                      <Label
                        x={(a.x || a.x1 || 0) + 10}
                        y={(a.y || a.y1 || 0) - 20}
                        onClick={() => deleteAnnotation(a._id)}
                      >
                        <Tag fill="red" pointerDirection="up" />
                        <KText text="❌" fontSize={16} fill="white" padding={2} />
                      </Label>
                    )}
                  </Group>
                );
              })}

              {/* Temporary drawing preview */}
              {drawing?.type === "box" && (
                <Rect
                  x={drawing.x}
                  y={drawing.y}
                  width={drawing.w}
                  height={drawing.h}
                  stroke="red"
                  dash={[4, 4]}
                />
              )}
              {drawing?.type === "arrow" && (
                <Arrow
                  points={[drawing.x1, drawing.y1, drawing.x2, drawing.y2]}
                  stroke="green"
                  strokeWidth={4}
                  pointerLength={10}
                  pointerWidth={10}
                  dash={[4, 4]}
                />
              )}

              <Transformer ref={trRef} rotateEnabled={true} resizeEnabled={true} />
            </Layer>
          </Stage>
        </SlideContainer>
      ) : (
        <p className="text-slate-400">No slide selected.</p>
      )}

      {/* Controls */}
      <div className="flex flex-wrap justify-center gap-2 mt-3">
        <button
          onClick={() =>
            setCurrentSlide((s) => (s - 1 + slides.length) % slides.length)
          }
          className="px-3 py-1 bg-slate-700 rounded"
        >
          ⏮ Prev
        </button>
        <button
          onClick={() => setCurrentSlide((s) => (s + 1) % slides.length)}
          className="px-3 py-1 bg-slate-700 rounded"
        >
          ⏭ Next
        </button>
        <button
          onClick={() => setIsPlaying(!isPlaying)}
          className="px-3 py-1 bg-slate-700 rounded"
        >
          {isPlaying ? "⏸ Pause" : "▶ Play"}
        </button>
        <button
          onClick={() => setIsFullscreen(true)}
          className="px-3 py-1 bg-slate-700 rounded"
        >
          ⛶ Enlarge
        </button>
      </div>

      {/* Annotation Tools */}
      <div className="flex flex-wrap justify-center gap-2 mt-2">
        <button
          onClick={() => setTool("x")}
          className={`px-3 py-1 rounded ${
            tool === "x" ? "bg-blue-600" : "bg-slate-700"
          }`}
        >
          ❌ X
        </button>
        <button
          onClick={() => setTool("box")}
          className={`px-3 py-1 rounded ${
            tool === "box" ? "bg-blue-600" : "bg-slate-700"
          }`}
        >
          ⬛ Box
        </button>
        <button
          onClick={() => setTool("arrow")}
          className={`px-3 py-1 rounded ${
            tool === "arrow" ? "bg-blue-600" : "bg-slate-700"
          }`}
        >
          ➡️ Arrow
        </button>
        <button
          onClick={() => setTool("text")}
          className={`px-3 py-1 rounded ${
            tool === "text" ? "bg-blue-600" : "bg-slate-700"
          }`}
        >
          📝 Text
        </button>
      </div>
    </section>
  );
}

// --- Main Dashboard ---
function CrosswindVisual({ wind, runway }) {
  if (!wind || wind === "--") return null;

  const match = wind.match(/(\d{3}|VRB)(\d{2})/);
  if (!match) return null;

  const dir = match[1] === "VRB" ? 0 : parseInt(match[1], 10);
  const spd = parseInt(match[2], 10);
  if (!spd) return null;

  const runwayHeading = runway === "10" ? 100 : 280;

  // FIX: Flip 180° so arrow points FROM wind direction
  const angleRad = (((dir + 180) - runwayHeading) * Math.PI) / 180;

  const headwind = (spd * Math.cos(angleRad)).toFixed(0);
  const crosswind = (spd * Math.sin(angleRad)).toFixed(0);

  return (
    <div className="absolute top-2 right-2 flex flex-col items-center text-xs">
      <svg width="60" height="60" viewBox="0 0 120 120">
        {/* Runway rectangle */}
        <rect x="50" y="20" width="20" height="80" fill="#555" rx="3" />

        {/* Runway number */}
        <text
          x="60"
          y="110"
          fontSize="10"
          fill="white"
          textAnchor="middle"
          fontWeight="bold"
        >
          {runway}
        </text>

        {/* Wind arrow */}
        <line
          x1="60"
          y1="60"
          x2={60 + 30 * Math.sin(angleRad)}
          y2={60 - 30 * Math.cos(angleRad)}
          stroke="green"
          strokeWidth="3"
          markerEnd="url(#arrowhead)"
        />

        <defs>
          <marker
            id="arrowhead"
            markerWidth="6"
            markerHeight="6"
            refX="5"
            refY="3"
            orient="auto"
          >
            <polygon points="0 0, 6 3, 0 6" fill="green" />
          </marker>
        </defs>
      </svg>

      {/* Labels */}
      <p className="text-white">XW: {crosswind} KT</p>
      <p className="text-white">HW: {headwind} KT</p>
    </div>
  );
}

export default function Dashboard() {
  const ICAO = "KMGM";

  // Weather
  const [metar, setMetar] = useState("");
  const [taf, setTaf] = useState("");
  const [parsed, setParsed] = useState({});
  const [cat, setCat] = useState("VFR");
  const [fits, setFits] = useState({ level: "NORMAL", tempF: NaN });
  const [altReq, setAltReq] = useState(false);
  const [notams, setNotams] = useState([]);
  const [lastUpdate, setLastUpdate] = useState(new Date());
  const [crosswind, setCrosswind] = useState(null);

  // Persisted state
  const [airfield, setAirfield] = useState({
    activeRunway: "10",
    rsc: "DRY",
    rscNotes: "",
    barriers: { east: "DOWN", west: "DOWN" },
    arff: "GREEN",
  });
  const [navaids, setNavaids] = useState({
    mgm: "IN",
    mxf: "IN",
    ils10: "IN",
    ils28: "IN",
  });
  const [bash, setBash] = useState({
    KMGM: "LOW",
    KMXF: "LOW",
    PHCR_MOA: "LOW",
    BHM_MOA: "LOW",
    VR060: "LOW",
    VR1056: "LOW",
    ShelbyRange: "LOW",
  });

  // Burn-in jitter
  const [jitter, setJitter] = useState({ x: 0, y: 0 });

  const API =
    (typeof process !== "undefined" && process.env?.REACT_APP_API_URL)
      ? process.env.REACT_APP_API_URL
      : "https://one87oss-airfield-dashboard.onrender.com";

  // --- Fetch functions ---
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

  async function fetchState() {
    try {
      const res = await axios.get(`${API}/api/state`);
      const s = res.data;
      if (s.airfield) setAirfield(s.airfield);
      if (s.navaids) setNavaids(s.navaids);
      if (s.bash) setBash(s.bash);
    } catch (err) {
      console.error("❌ Failed to fetch state:", err.message);
    }
  }

  async function saveState(updated) {
    try {
      await axios.post(`${API}/api/state`, updated);
    } catch (err) {
      console.error("❌ Failed to save state:", err.message);
    }
  }

  // --- Auto refresh + jitter ---
  useEffect(() => {
    fetchMetarTaf();
    fetchNotams();
    fetchState();

    const wxTimer = setInterval(fetchMetarTaf, 5 * 60 * 1000);   // 5 min
    const notamTimer = setInterval(fetchNotams, 15 * 60 * 1000); // 15 min
    const stateTimer = setInterval(fetchState, 5 * 60 * 1000);   // 5 min

    const jitterTimer = setInterval(() => {
      setJitter({
        x: Math.floor(Math.random() * 3) - 1,
        y: Math.floor(Math.random() * 3) - 1,
      });
    }, 60000); // 1 min

    return () => {
      clearInterval(wxTimer);
      clearInterval(notamTimer);
      clearInterval(stateTimer);
      clearInterval(jitterTimer);
    };
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

    setCrosswind(computeCrosswind(p.wind, airfield.activeRunway));
  }, [metar, taf, airfield.activeRunway]);
  return (
    <div
      className="min-h-screen bg-slate-950 text-slate-100 p-4"
      style={{ transform: `translate(${jitter.x}px, ${jitter.y}px)` }}
    >
      {/* Header */}
      <header className="flex flex-col items-center mb-4 text-center relative">
  {/* Logo top-left */}
  <img
    src="/oss-patch.png"
    alt="187th OSS Patch"
    className="absolute top-0 left-0 w-20 h-20 md:w-28 md:h-28 object-contain m-2"
  />

  <h1 className="text-xl font-bold">
    187th Operations Support Squadron — {ICAO} Dannelly Field
  </h1>
  <p className="text-lg font-semibold">Airfield Dashboard</p>

  <div className="text-sm mt-2">
    {/* Local time in ICAO format */}
    <p>
      Local:{" "}
      {new Date()
        .toLocaleDateString("en-GB", {
          day: "2-digit",
          month: "short",
          year: "numeric",
        })
        .toUpperCase()
        .replace(",", "")}{" "}
      {new Date()
        .toLocaleTimeString([], {
          hour12: false,
          hour: "2-digit",
          minute: "2-digit",
        })
        .replace(":", "")}
      L
    </p>

    {/* Zulu time in ICAO format */}
    <p>
      Zulu:{" "}
      {new Date()
        .toLocaleDateString("en-GB", {
          day: "2-digit",
          month: "short",
          year: "numeric",
          timeZone: "UTC",
        })
        .toUpperCase()
        .replace(",", "")}{" "}
      {new Date()
        .toLocaleTimeString("en-GB", {
          hour12: false,
          hour: "2-digit",
          minute: "2-digit",
          timeZone: "UTC",
        })
        .replace(":", "")}
      Z
    </p>

    {/* Last updated */}
    <p className="text-slate-400">
      Last Updated:{" "}
      {lastUpdate
        .toLocaleDateString("en-GB", {
          day: "2-digit",
          month: "short",
          year: "numeric",
        })
        .toUpperCase()
        .replace(",", "")}{" "}
      {lastUpdate
        .toLocaleTimeString([], {
          hour12: false,
          hour: "2-digit",
          minute: "2-digit",
        })
        .replace(":", "")}
      L
    </p>

    <button
      onClick={() => {
        fetchMetarTaf();
        fetchNotams();
        fetchState();
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
              onClick={() => {
                const newAirfield = {
                  ...airfield,
                  activeRunway: airfield.activeRunway === "10" ? "28" : "10",
                };
                setAirfield(newAirfield);
                saveState({ airfield: newAirfield });
              }}
            >
              {airfield.activeRunway}
            </button>
          </div>

          {/* RSC */}
          <div className="mb-2">
            <p className="font-semibold">RSC</p>
            <div className="flex gap-2">
              <button
                className={`px-3 py-1 rounded ${
                  airfield.rsc === "DRY"
                    ? "bg-green-600"
                    : airfield.rsc === "WET"
                    ? "bg-red-600"
                    : "bg-slate-700"
                }`}
                onClick={() => {
                  const newAirfield = {
                    ...airfield,
                    rsc:
                      airfield.rsc === "DRY"
                        ? "WET"
                        : airfield.rsc === "WET"
                        ? "N/A"
                        : "DRY",
                  };
                  setAirfield(newAirfield);
                  saveState({ airfield: newAirfield });
                }}
              >
                {airfield.rsc}
              </button>
              <input
                type="text"
                placeholder="Notes"
                value={airfield.rscNotes}
                onChange={(e) => {
                  const newAirfield = { ...airfield, rscNotes: e.target.value };
                  setAirfield(newAirfield);
                  saveState({ airfield: newAirfield });
                }}
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
                    airfield.barriers[side] === "UNSERVICEABLE"
                      ? "bg-red-600"
                      : "bg-green-600"
                  }`}
                  onClick={() => {
                    const newBarriers = {
                      ...airfield.barriers,
                      [side]:
                        airfield.barriers[side] === "DOWN"
                          ? "UP"
                          : airfield.barriers[side] === "UP"
                          ? "UNSERVICEABLE"
                          : "DOWN",
                    };
                    const newAirfield = { ...airfield, barriers: newBarriers };
                    setAirfield(newAirfield);
                    saveState({ airfield: newAirfield });
                  }}
                >
                  {side.toUpperCase()} BAK-12 {airfield.barriers[side]}
                </button>
              ))}
            </div>
          </div>

          {/* NAVAIDs */}
          <div className="mb-2">
            <p className="font-semibold">NAVAIDs</p>
            <div className="flex gap-2 flex-wrap">
              {Object.keys(navaids).map((n) => (
                <button
                  key={n}
                  className={`px-2 py-1 rounded ${
                    navaids[n] === "IN" ? "bg-green-600" : "bg-red-600"
                  }`}
                  onClick={() => {
                    const updated = {
                      ...navaids,
                      [n]: navaids[n] === "IN" ? "OUT" : "IN",
                    };
                    setNavaids(updated);
                    saveState({ navaids: updated });
                  }}
                >
                  {n === "mgm"
                    ? "MGM TACAN"
                    : n === "mxf"
                    ? "MXF TACAN"
                    : n === "ils10"
                    ? "ILS 10"
                    : n === "ils28"
                    ? "ILS 28"
                    : n.toUpperCase()}
                </button>
              ))}
            </div>
          </div>

          {/* ARFF */}
          <div className="mb-2">
            <p className="font-semibold">ARFF</p>
            <button
              className={`px-3 py-1 rounded ${
                airfield.arff === "GREEN"
                  ? "bg-green-600"
                  : airfield.arff === "YELLOW"
                  ? "bg-yellow-500"
                  : "bg-red-600"
              }`}
              onClick={() => {
                const newAirfield = {
                  ...airfield,
                  arff:
                    airfield.arff === "GREEN"
                      ? "YELLOW"
                      : airfield.arff === "YELLOW"
                      ? "RED"
                      : "GREEN",
                };
                setAirfield(newAirfield);
                saveState({ airfield: newAirfield });
              }}
            >
              ARFF {airfield.arff}
            </button>
          </div>
        </section>

        {/* Weather */}
<section className="relative border border-slate-700 rounded-lg p-3 flex flex-col h-[500px]">
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

  {/* Crosswind diagram (mini, top-right) */}
<CrosswindVisual wind={parsed.wind} runway={airfield.activeRunway} />

{/* Shift text down so it clears the icon */}
<div className="grid grid-cols-2 gap-2 text-sm mb-2 mt-16">
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
                    : bash[loc] === "SEVERE"
                    ? "bg-red-600"
                    : "bg-slate-700"
                }`}
                onClick={() => {
                  const newLevel =
                    bash[loc] === "LOW"
                      ? "MODERATE"
                      : bash[loc] === "MODERATE"
                      ? "SEVERE"
                      : bash[loc] === "SEVERE"
                      ? "N/A"
                      : "LOW";

                  const updated = { ...bash, [loc]: newLevel };
                  setBash(updated);
                  saveState({ bash: updated });
                }}
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
