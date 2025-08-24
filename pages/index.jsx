import { useState, useEffect, useRef } from "react";
import axios from "axios";
import fitsTable from "../data/fitsTable.json";

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

function lookupFits(tempF, dewF) {
  const nearestTemp = Math.round(tempF / 2) * 2;
  const nearestDew = Math.round(dewF / 2) * 2;
  const row = fitsTable[nearestTemp];
  if (!row) return { level: "NORMAL", f: NaN };

  const value = row[nearestDew];
  if (value === undefined) return { level: "NORMAL", f: NaN };

  let level = "NORMAL";
  if (value >= 86 && value < 90) level = "CAUTION";
  else if (value >= 90 && value < 95) level = "DANGER";
  else if (value >= 95) level = "CANCEL";

  return { level, f: value };
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
        h: Math.abs(y2 - y1),
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
      {/* SVG Annotations */}
      <svg
        ref={svgRef}
        className="absolute inset-0 w-full h-full"
        onClick={handleClick}
        onMouseDown={handleDragStart}
        onMouseUp={handleDragEnd}
      >
        <defs>
          <marker id="arrowhead" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto">
            <polygon points="0 0, 10 3.5, 0 7" fill="green" />
          </marker>
        </defs>
        {annotations[slideKey]?.map((a, i) => {
          if (a.type === "box") return <rect key={i} x={a.x} y={a.y} width={a.w} height={a.h} stroke="red" fill="transparent" />;
          if (a.type === "x") return <text key={i} x={a.x} y={a.y} fontSize="32" fill="red" fontWeight="bold">X</text>;
          if (a.type === "arrow") return <line key={i} x1={a.x1} y1={a.y1} x2={a.x2} y2={a.y2} stroke="green" strokeWidth="4" markerEnd="url(#arrowhead)" />;
          if (a.type === "text")
            return (
              <foreignObject key={i} x={a.x} y={a.y} width="200" height="50">
                <div className="px-1 text-sm font-bold text-white bg-black border border-red-600 rounded"
                     style={{ display: "inline-block", maxWidth: "180px", wordWrap: "break-word" }}>
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
            <button onClick={() => setIsFullscreen(true)} className="px-2 py-1 bg-slate-700 rounded text-sm">🔎 Expand</button>
          </h2>
          <div className="relative bg-slate-900 flex items-center justify-center rounded overflow-hidden h-[500px]">
            {viewer}
          </div>
          <div className="flex justify-center gap-2 mb-2 mt-2">
            <button onClick={prevSlide} className="px-3 py-1 bg-slate-700 rounded">⬅️</button>
            {isPlaying ? (
              <button onClick={() => setIsPlaying(false)} className="px-3 py-1 bg-red-600 rounded">⏹️ Stop</button>
            ) : (
              <button onClick={() => setIsPlaying(true)} className="px-3 py-1 bg-green-600 rounded">▶️ Play</button>
            )}
            <button onClick={nextSlide} className="px-3 py-1 bg-slate-700 rounded">➡️</button>
          </div>
          <div className="flex justify-center gap-2 mt-2">
            <button onClick={() => setTool("box")}   className={tool==="box" ? "bg-blue-600" : "bg-slate-700"}>🟥 Box</button>
            <button onClick={() => setTool("x")}     className={tool==="x" ? "bg-blue-600" : "bg-slate-700"}>❌ X</button>
            <button onClick={() => setTool("arrow")} className={tool==="arrow" ? "bg-blue-600" : "bg-slate-700"}>➡ Arrow</button>
            <button onClick={() => setTool("text")}  className={tool==="text" ? "bg-blue-600" : "bg-slate-700"}>📝 Text</button>
            <button onClick={clearAnnotations} className="bg-red-600 px-2 py-1 rounded">🗑 Clear</button>
          </div>
        </section>
      )}

      {/* Fullscreen View */}
      {isFullscreen && (
        <div className="fixed inset-0 z-50 bg-black bg-opacity-95 flex flex-col">
          <div className="flex justify-between items-center p-3 text-white">
            <h2 className="text-lg font-bold">Airfield Slides</h2>
            <button onClick={() => setIsFullscreen(false)} className="px-2 py-1 bg-red-600 rounded">❌ Close</button>
          </div>
          <div className="flex-1 flex items-center justify-center">{viewer}</div>
          <div className="flex justify-center gap-2 mb-2 mt-2">
            <button onClick={prevSlide} className="px-3 py-1 bg-slate-700 rounded">⬅️</button>
            {isPlaying ? (
              <button onClick={() => setIsPlaying(false)} className="px-3 py-1 bg-red-600 rounded">⏹️ Stop</button>
            ) : (
              <button onClick={() => setIsPlaying(true)} className="px-3 py-1 bg-green-600 rounded">▶️ Play</button>
            )}
            <button onClick={nextSlide} className="px-3 py-1 bg-slate-700 rounded">➡️</button>
          </div>
          <div className="flex justify-center gap-2 mt-2 mb-4">
            <button onClick={() => setTool("box")}   className={tool==="box" ? "bg-blue-600" : "bg-slate-700"}>🟥 Box</button>
            <button onClick={() => setTool("x")}     className={tool==="x" ? "bg-blue-600" : "bg-slate-700"}>❌ X</button>
            <button onClick={() => setTool("arrow")} className={tool==="arrow" ? "bg-blue-600" : "bg-slate-700"}>➡ Arrow</button>
            <button onClick={() => setTool("text")}  className={tool==="text" ? "bg-blue-600" : "bg-slate-700"}>📝 Text</button>
            <button onClick={clearAnnotations} className="bg-red-600 px-2 py-1 rounded">🗑 Clear</button>
          </div>
        </div>
      )}
    </>
  );
}

// --- Dashboard (Default Export) ---
export default function Dashboard() {
  const ICAO = "KMGM";
  // ... your full METAR/TAF/NOTAM/BASH state + logic goes here (unchanged)

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 p-4">
      {/* keep your header, airfield status, weather, notams, etc. */}
      {/* finally include slides */}
      <SlidesCard />
    </div>
  );
}
