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
  Image as KonvaImage 
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

// --- SlidesCard ---
function SlidesCard() {
  const [slides, setSlides] = useState([]);
  const [currentSlide, setCurrentSlide] = useState(0);
  const [annotations, setAnnotations] = useState({});
  const [tool, setTool] = useState(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [drawing, setDrawing] = useState(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [imageObj, setImageObj] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const containerRef = useRef();
  const stageRef = useRef();
  const trRef = useRef();
  const [stageSize, setStageSize] = useState({ width: 800, height: 400 });

  const API =
    process.env?.REACT_APP_API_URL || "https://airfield-dashboard.onrender.com";

  // load slides + annotations
  useEffect(() => {
    axios.get(`${API}/api/slides`).then((res) => setSlides(res.data));
    axios.get(`${API}/api/annotations`).then((res) =>
      setAnnotations(res.data.slides || {})
    );
  }, [API]);

  // load current image
  useEffect(() => {
    if (!slides[currentSlide]) return;
    const img = new window.Image();
    img.src = `${API}/slides/${slides[currentSlide]}`;
    img.onload = () => {
      setImageObj(img);
      setTimeout(() => {
        if (containerRef.current) {
          const rect = containerRef.current.getBoundingClientRect();
          setStageSize({
            width: rect.width,
            height: rect.height,
          });
        }
      }, 50);
    };
  }, [slides, currentSlide, isFullscreen]);

  // slideshow autoplay
  useEffect(() => {
    if (isPlaying && slides.length > 0) {
      const interval = setInterval(
        () => setCurrentSlide((s) => (s + 1) % slides.length),
        5000
      );
      return () => clearInterval(interval);
    }
  }, [isPlaying, slides.length]);

  // transformer update when selection changes
  useEffect(() => {
    if (trRef.current && stageRef.current && selectedId) {
      const shape = stageRef.current.findOne(`#${selectedId}`);
      if (shape) {
        trRef.current.nodes([shape]);
        trRef.current.getLayer().batchDraw();
      }
    }
  }, [selectedId, annotations]);

  // Escape key to exit fullscreen
  useEffect(() => {
    const handleKey = (e) => {
      if (e.key === "Escape") setIsFullscreen(false);
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, []);

  const saveAnnotations = (updated) => {
    setAnnotations(updated);
    axios.post(`${API}/api/annotations`, { slides: updated });
  };

  const addAnnotation = (annot) => {
    const file = slides[currentSlide];
    if (!file) return;
    const annots = { ...annotations };
    if (!annots[file]) annots[file] = [];
    annots[file].push({ _id: uuidv4(), ...annot });
    saveAnnotations(annots);
  };

  const updateAnnotation = (id, newAttrs) => {
    const file = slides[currentSlide];
    if (!file) return;
    const annots = { ...annotations };
    annots[file] = annots[file].map((a) =>
      a._id === id ? { ...a, ...newAttrs } : a
    );
    saveAnnotations(annots);
  };

  const deleteAnnotation = (id) => {
    const file = slides[currentSlide];
    if (!file) return;
    const annots = { ...annotations };
    annots[file] = annots[file].filter((a) => a._id !== id);
    saveAnnotations(annots);
    setSelectedId(null);
    trRef.current?.nodes([]);
  };

  const clearAllAnnotations = () => {
    const file = slides[currentSlide];
    if (!file) return;
    const annots = { ...annotations, [file]: [] };
    saveAnnotations(annots);
    setSelectedId(null);
    trRef.current?.nodes([]);
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
  const slideKey = file || "unknown";

  let drawW = 0,
    drawH = 0,
    offsetX = 0,
    offsetY = 0,
    scale = 1;
  if (imageObj) {
    scale = Math.min(
      stageSize.width / imageObj.width,
      stageSize.height / imageObj.height
    );
    drawW = imageObj.width * scale;
    drawH = imageObj.height * scale;
    offsetX = (stageSize.width - drawW) / 2;
    offsetY = (stageSize.height - drawH) / 2;
  }

  const migrate = (val, axis = "x") => {
    if (!imageObj) return val;
    return val < (axis === "x" ? imageObj.width : imageObj.height)
      ? val
      : (val - (axis === "x" ? offsetX : offsetY)) / scale;
  };

  const renderStage = () => (
    <Stage
      ref={stageRef}
      width={stageSize.width}
      height={stageSize.height}
      onMouseDown={(e) => {
        if (!tool || e.target !== e.target.getStage()) return;
        const pos = e.target.getStage().getPointerPosition();
        if (!pos) return;

        const imgX = (pos.x - offsetX) / scale;
        const imgY = (pos.y - offsetY) / scale;

        if (tool === "box") {
          setDrawing({ type: "box", x: imgX, y: imgY, w: 0, h: 0 });
        } else if (tool === "arrow") {
          setDrawing({ type: "arrow", x1: imgX, y1: imgY, x2: imgX, y2: imgY });
        } else if (tool === "x") {
          addAnnotation({ type: "x", x: imgX, y: imgY });
        } else if (tool === "text") {
          const text = prompt("Enter note:");
          if (text) addAnnotation({ type: "text", x: imgX, y: imgY, text });
        }
      }}
      onMouseMove={(e) => {
        if (!drawing) return;
        const pos = e.target.getStage().getPointerPosition();
        if (!pos) return;

        const imgX = (pos.x - offsetX) / scale;
        const imgY = (pos.y - offsetY) / scale;

        if (drawing.type === "box") {
          setDrawing({ ...drawing, w: imgX - drawing.x, h: imgY - drawing.y });
        } else if (drawing.type === "arrow") {
          setDrawing({ ...drawing, x2: imgX, y2: imgY });
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
        <KonvaImage
          image={imageObj}
          x={offsetX}
          y={offsetY}
          width={drawW}
          height={drawH}
          listening={false}
        />

        {annotations[slideKey]?.map((a) => {
          const ax = migrate(a.x, "x");
          const ay = migrate(a.y, "y");

          const commonProps = {
            key: a._id,
            id: a._id,
            draggable: true,
            onClick: () => setSelectedId(a._id),
            onTap: () => setSelectedId(a._id),
            onContextMenu: (e) => {
              e.evt.preventDefault();
              deleteAnnotation(a._id);
            },
            onDragEnd: (e) => {
              const imgX = (e.target.x() - offsetX) / scale;
              const imgY = (e.target.y() - offsetY) / scale;
              updateAnnotation(a._id, { x: imgX, y: imgY });
            },
          };

          if (a.type === "box")
            return (
              <Rect
                {...commonProps}
                x={offsetX + ax * scale}
                y={offsetY + ay * scale}
                width={a.w * scale}
                height={a.h * scale}
                stroke="red"
              />
            );
          if (a.type === "x")
            return (
              <KText
                {...commonProps}
                x={offsetX + ax * scale}
                y={offsetY + ay * scale}
                text="X"
                fontSize={32 * scale}
                fill="red"
              />
            );
          if (a.type === "arrow")
            return (
              <Arrow
                {...commonProps}
                points={[
                  offsetX + migrate(a.x1, "x") * scale,
                  offsetY + migrate(a.y1, "y") * scale,
                  offsetX + migrate(a.x2, "x") * scale,
                  offsetY + migrate(a.y2, "y") * scale,
                ]}
                stroke="green"
                strokeWidth={4 * scale}
                pointerLength={10 * scale}
                pointerWidth={10 * scale}
              />
            );
          if (a.type === "text")
            return (
              <KText
                {...commonProps}
                x={offsetX + ax * scale}
                y={offsetY + ay * scale}
                text={a.text}
                fontSize={16 * scale}
                fill="white"
              />
            );
          return null;
        })}

        {drawing?.type === "box" && (
          <Rect
            x={offsetX + drawing.x * scale}
            y={offsetY + drawing.y * scale}
            width={drawing.w * scale}
            height={drawing.h * scale}
            stroke="red"
            dash={[4, 4]}
          />
        )}
        {drawing?.type === "arrow" && (
          <Arrow
            points={[
              offsetX + drawing.x1 * scale,
              offsetY + drawing.y1 * scale,
              offsetX + drawing.x2 * scale,
              offsetY + drawing.y2 * scale,
            ]}
            stroke="green"
            strokeWidth={4 * scale}
            pointerLength={10 * scale}
            pointerWidth={10 * scale}
            dash={[4, 4]}
          />
        )}

        <Transformer ref={trRef} rotateEnabled resizeEnabled />
      </Layer>
    </Stage>
  );

  return (
    <section className="border border-slate-700 rounded-lg p-3 flex flex-col md:col-span-2 relative">
      <h2 className="text-lg font-bold underline mb-2">Airfield Slides</h2>

      {isFullscreen ? (
        <div className="fixed inset-0 z-40 bg-black flex flex-col">
          <div className="flex justify-between p-2 bg-slate-900 text-white relative z-50">
            <button
              onClick={() => setIsFullscreen(false)}
              className="px-3 py-1 bg-red-600 rounded"
            >
              ✖ Close
            </button>
            <button
              onClick={clearAllAnnotations}
              className="px-3 py-1 bg-yellow-600 rounded"
            >
              🧹 Clear All
            </button>
          </div>
          <div ref={containerRef} className="flex-1 flex items-center justify-center overflow-auto">
            {renderStage()}
          </div>
        </div>
      ) : (
        <div
          ref={containerRef}
          className="relative flex-1 bg-slate-900 rounded overflow-hidden h-[400px]"
        >
          {renderStage()}
        </div>
      )}

      {/* Toolbar */}
      <div className="flex flex-wrap justify-center gap-2 mt-3">
        <button onClick={() => setCurrentSlide((s) => (s - 1 + slides.length) % slides.length)} className="px-3 py-1 bg-slate-700 rounded">⏮ Prev</button>
        <button onClick={() => setCurrentSlide((s) => (s + 1) % slides.length)} className="px-3 py-1 bg-slate-700 rounded">⏭ Next</button>
        <button onClick={() => setIsPlaying(!isPlaying)} className="px-3 py-1 bg-slate-700 rounded">{isPlaying ? "⏸ Pause" : "▶ Play"}</button>
        <button onClick={() => setIsFullscreen(true)} className="px-3 py-1 bg-slate-700 rounded">⛶ Enlarge</button>
        <button onClick={clearAllAnnotations} className="px-3 py-1 bg-yellow-600 rounded">🧹 Clear All</button>
      </div>

      {/* Tools */}
      <div className="flex flex-wrap justify-center gap-2 mt-2">
        <button onClick={() => setTool("x")} className={`px-3 py-1 rounded ${tool === "x" ? "bg-blue-600" : "bg-slate-700"}`}>❌ X</button>
        <button onClick={() => setTool("box")} className={`px-3 py-1 rounded ${tool === "box" ? "bg-blue-600" : "bg-slate-700"}`}>⬛ Box</button>
        <button onClick={() => setTool("arrow")} className={`px-3 py-1 rounded ${tool === "arrow" ? "bg-blue-600" : "bg-slate-700"}`}>➡️ Arrow</button>
        <button onClick={() => setTool("text")} className={`px-3 py-1 rounded ${tool === "text" ? "bg-blue-600" : "bg-slate-700"}`}>📝 Text</button>
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
