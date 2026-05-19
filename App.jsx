import { useState, useEffect, useCallback } from "react";

// ─── CONSTANTS ────────────────────────────────────────────────────────────────
const LAT = 43.7, LON = -79.42;

const TARGETS = {
  wind200:  { min: 130, ideal: 160, max: 210, label: "200 hPa Jet (km/h)",      unit: "km/h", key: "wind_speed_200hPa" },
  wind300:  { min: 130, ideal: 145, max: 185, label: "300 hPa Jet (km/h)",      unit: "km/h", key: "wind_speed_300hPa" },
  geo300:   { min: 9200, ideal: 9390, max: 9500, label: "300 hPa GeoHeight (m)", unit: "m",    key: "geopotential_height_300hPa" },
  wind500:  { min: 55,  ideal: 95,  max: 140, label: "500 hPa Wind (km/h)",     unit: "km/h", key: "wind_speed_500hPa" },
  pressure: { min: 1008, ideal: 1016, max: 1030, label: "Sea Level P (hPa)",    unit: "hPa",  key: "pressure_msl" },
};

const MONTH_NAMES = [
  "January","February","March","April","May","June",
  "July","August","September","October","November","December"
];
const DAY_NAMES = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];

// ─── API ──────────────────────────────────────────────────────────────────────
async function fetchMonthData(year, month) {
  const pad = n => String(n).padStart(2, "0");
  const start = `${year}-${pad(month + 1)}-01`;
  const lastDay = new Date(year, month + 1, 0).getDate();
  const end = `${year}-${pad(month + 1)}-${pad(lastDay)}`;

  const pressureVars = [
    "wind_speed_200hPa",
    "wind_speed_300hPa",
    "geopotential_height_300hPa",
    "wind_speed_500hPa",
  ].join(",");

  const url =
    `https://historical-forecast-api.open-meteo.com/v1/forecast` +
    `?latitude=${LAT}&longitude=${LON}` +
    `&start_date=${start}&end_date=${end}` +
    `&hourly=${pressureVars},pressure_msl` +
    `&wind_speed_unit=kmh` +
    `&timezone=America%2FToronto`;

  const res = await fetch(url);
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`API ${res.status}: ${txt.slice(0, 200)}`);
  }
  const json = await res.json();
  return parseHourly(json);
}

function parseHourly(json) {
  const h = json.hourly;
  if (!h || !h.time) throw new Error("Unexpected API response shape");

  const byDate = {};
  h.time.forEach((t, i) => {
    const date = t.split("T")[0];
    if (!byDate[date]) {
      byDate[date] = { wind200: [], wind300: [], geo300: [], wind500: [], pressure: [] };
    }
    const d = byDate[date];
    const push = (arr, val) => { if (val != null && !isNaN(val)) arr.push(val); };
    push(d.wind200,  h["wind_speed_200hPa"]?.[i]);
    push(d.wind300,  h["wind_speed_300hPa"]?.[i]);
    push(d.geo300,   h["geopotential_height_300hPa"]?.[i]);
    push(d.wind500,  h["wind_speed_500hPa"]?.[i]);
    push(d.pressure, h["pressure_msl"]?.[i]);
  });

  const result = {};
  Object.entries(byDate).forEach(([date, arrs]) => {
    const avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
    const max = a => a.length ? Math.max(...a) : null;
    result[date] = {
      wind200:  max(arrs.wind200),
      wind300:  max(arrs.wind300),
      geo300:   avg(arrs.geo300),
      wind500:  max(arrs.wind500),
      pressure: avg(arrs.pressure),
    };
  });
  return result;
}

// ─── SCORING ──────────────────────────────────────────────────────────────────
function scoreMetric(key, val) {
  if (val == null) return null;
  const t = TARGETS[key];

  if (key === "geo300" || key === "pressure") {
    if (val < t.min) return Math.max(0, ((val - (t.min - 300)) / 300) * 50);
    if (val > t.max) return Math.max(0, 100 - ((val - t.max) / 100) * 20);
    return 50 + ((val - t.min) / (t.max - t.min)) * 50;
  } else {
    if (val < t.min) return Math.max(0, (val / t.min) * 55);
    if (val > t.max) return Math.max(0, 100 - ((val - t.max) / (t.max * 0.5)) * 55);
    const distFromIdeal = Math.abs(val - t.ideal);
    const range = Math.max(t.ideal - t.min, t.max - t.ideal);
    return 55 + (1 - distFromIdeal / range) * 45;
  }
}

function calcDay(raw) {
  if (!raw) return null;
  const scores = {};
  let total = 0, count = 0;
  Object.keys(TARGETS).forEach(k => {
    const s = scoreMetric(k, raw[k]);
    scores[k] = s;
    if (s != null) { total += s; count++; }
  });
  const composite = count ? Math.round(total / count) : null;
  const status = composite == null ? "unknown"
    : composite >= 55 && composite <= 75 ? "perfect"
    : composite > 75 ? "high"
    : "low";
  return { composite, status, scores, raw };
}

function metricColor(key, val) {
  if (val == null) return "#6b7280";
  const t = TARGETS[key];
  if (val < t.min) return "#3b82f6";
  if (val > t.max) return "#ef4444";
  return "#a855f7";
}

function barPct(key, val) {
  if (val == null) return 0;
  const t = TARGETS[key];
  const lo = key === "geo300" ? t.min - 300 : key === "pressure" ? 990 : 0;
  const hi = key === "geo300" ? t.max + 100 : key === "pressure" ? t.max + 10 : t.max * 1.4;
  return ((val - lo) / (hi - lo)) * 100;
}

function buildSummary(selInfo) {
  const { composite, status, raw } = selInfo;
  const score = composite ?? "—";

  if (status === "perfect") {
    return `Score ${score}/100 — All dials in optimal range. Jet speed at upper levels is within target, geopotential height shows neutral-to-ridge pattern, surface pressure supports settled conditions. God would leave the dial here.`;
  }
  if (status === "high") {
    const parts = [];
    if (raw?.wind200 > 210) parts.push(`200 hPa jet (${raw.wind200.toFixed(0)} km/h) above the 210 km/h threshold`);
    if (raw?.wind300 > 185) parts.push(`300 hPa jet (${raw.wind300.toFixed(0)} km/h) above the 185 km/h cap`);
    if (raw?.geo300 < 9200) parts.push(`geopotential (${raw.geo300.toFixed(0)} m) well below 9350 m normal — deep cold trough`);
    if (raw?.pressure < 1008) parts.push(`sea-level pressure (${raw.pressure.toFixed(1)} hPa) low — active cyclone at surface`);
    const detail = parts.length ? ` ${parts.join("; ")}. ` : " ";
    return `Score ${score}/100 — Dial too high / over-amplified.${detail}God would reduce Rossby wave amplitude and shift the pattern northward.`;
  }
  const parts = [];
  if (raw?.wind200 < 130) parts.push(`200 hPa jet (${raw.wind200.toFixed(0)} km/h) below the 130 km/h threshold`);
  if (raw?.wind300 < 130) parts.push(`300 hPa jet (${raw.wind300.toFixed(0)} km/h) also collapsed`);
  if (raw?.geo300 > 9450 && (raw?.wind200 ?? 0) < 130) parts.push(`geopotential (${raw.geo300.toFixed(0)} m) high but jet absent — stagnant cut-off ridge`);
  if (raw?.pressure < 1010) parts.push(`pressure (${raw.pressure.toFixed(1)} hPa) low with no steering flow to clear it`);
  const detail = parts.length ? ` ${parts.join("; ")}. ` : " ";
  return `Score ${score}/100 — Dial too low / collapsed.${detail}God would spin the dial up to 140–150 km/h to restore progressive west-east flow.`;
}

// ─── STYLES ───────────────────────────────────────────────────────────────────
const S = {
  app: {
    background: "#0d0f14", minHeight: "100vh", color: "#e4e8f0",
    fontFamily: "'Segoe UI', system-ui, sans-serif", padding: "20px 16px",
  },
  header: { textAlign: "center", marginBottom: 28 },
  h1: {
    fontSize: "clamp(1.5rem,4vw,2.2rem)", fontWeight: 900, letterSpacing: "-0.03em",
    background: "linear-gradient(135deg,#fff 30%,#a855f7)",
    WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent",
    backgroundClip: "text", margin: 0,
  },
  sub: { color: "#6b7280", fontSize: "0.82rem", marginTop: 6, fontFamily: "monospace" },
  statusBar: {
    display: "flex", alignItems: "center", justifyContent: "center",
    gap: 8, marginBottom: 18, fontFamily: "monospace", fontSize: "0.75rem", color: "#6b7280",
  },
  dot: (color) => ({ width: 8, height: 8, borderRadius: "50%", background: color, boxShadow: `0 0 6px ${color}`, flexShrink: 0 }),
  legend: {
    background: "#13161e", border: "1px solid #1e2230", borderRadius: 10,
    padding: "14px 18px", marginBottom: 16, display: "grid",
    gridTemplateColumns: "repeat(auto-fit,minmax(190px,1fr))", gap: 10,
  },
  legendTitle: {
    gridColumn: "1/-1", fontSize: "0.65rem", fontFamily: "monospace",
    color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 4,
  },
  legendItem: { display: "flex", alignItems: "flex-start", gap: 8, fontSize: "0.76rem" },
  legendDot: (c) => ({ width: 10, height: 10, borderRadius: 3, background: c, flexShrink: 0, marginTop: 3 }),
  metricsBox: {
    background: "#13161e", border: "1px solid #1e2230", borderRadius: 10,
    padding: "14px 18px", marginBottom: 16,
  },
  metricsTitle: {
    fontSize: "0.65rem", fontFamily: "monospace", color: "#6b7280",
    textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 10,
  },
  metricsGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(200px,1fr))", gap: 8 },
  metricItem: {
    background: "rgba(168,85,247,0.07)", borderRadius: 6, padding: "8px 11px",
    borderLeft: "3px solid #a855f7", fontSize: "0.74rem",
  },
  metricItemLabel: { fontWeight: 700, marginBottom: 2 },
  metricItemDesc: { color: "#6b7280", fontFamily: "monospace", fontSize: "0.68rem", lineHeight: 1.4 },
  calNav: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 },
  navBtn: {
    background: "#13161e", border: "1px solid #1e2230", color: "#e4e8f0",
    padding: "7px 16px", borderRadius: 6, cursor: "pointer", fontFamily: "monospace",
    fontSize: "0.78rem", transition: "border-color 0.2s",
  },
  calTitle: { fontSize: "1.1rem", fontWeight: 700, letterSpacing: "-0.01em" },
  calWrap: {
    background: "#13161e", border: "1px solid #1e2230", borderRadius: 10,
    overflow: "hidden", marginBottom: 20,
  },
  calHead: {
    display: "grid", gridTemplateColumns: "repeat(7,1fr)",
    background: "rgba(255,255,255,0.03)", borderBottom: "1px solid #1e2230",
  },
  calHeadCell: {
    padding: "9px 0", textAlign: "center", fontSize: "0.68rem",
    fontFamily: "monospace", color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.06em",
  },
  calGrid: { display: "grid", gridTemplateColumns: "repeat(7,1fr)" },
  dayCell: (status, selected, empty, future) => ({
    minHeight: 78, padding: 8,
    borderRight: "1px solid #1e2230", borderBottom: "1px solid #1e2230",
    cursor: empty || future ? "default" : "pointer",
    display: "flex", flexDirection: "column", alignItems: "center",
    justifyContent: "flex-start", gap: 3, position: "relative",
    transition: "background 0.15s", opacity: future ? 0.3 : 1,
    background: empty ? "rgba(0,0,0,0.15)"
      : status === "perfect" ? "rgba(168,85,247,0.12)"
      : status === "high"    ? "rgba(239,68,68,0.10)"
      : status === "low"     ? "rgba(59,130,246,0.10)"
      : "transparent",
    outline: selected ? "2px solid #a855f7" : "none",
    outlineOffset: -2,
  }),
  dayNum: (status) => ({
    fontSize: "0.8rem", fontWeight: 700, fontFamily: "monospace",
    color: status === "perfect" ? "#a855f7" : status === "high" ? "#ef4444" : status === "low" ? "#3b82f6" : "#9ca3af",
  }),
  dayArrow: { fontSize: "1.15rem", lineHeight: 1 },
  dayScore: (status) => ({
    fontSize: "0.58rem", fontFamily: "monospace", textAlign: "center",
    color: status === "perfect" ? "#a855f7" : status === "high" ? "#ef4444" : status === "low" ? "#3b82f6" : "#6b7280",
  }),
  detail: { background: "#13161e", border: "1px solid #1e2230", borderRadius: 10, padding: 20 },
  detailHeader: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 18, flexWrap: "wrap", gap: 10 },
  detailDate: { fontSize: "1.1rem", fontWeight: 800, letterSpacing: "-0.02em" },
  badge: (status) => ({
    padding: "5px 14px", borderRadius: 20, fontSize: "0.82rem", fontWeight: 700,
    background: status === "perfect" ? "rgba(168,85,247,0.15)" : status === "high" ? "rgba(239,68,68,0.12)" : "rgba(59,130,246,0.12)",
    color: status === "perfect" ? "#a855f7" : status === "high" ? "#ef4444" : "#3b82f6",
    border: `1px solid ${status === "perfect" ? "rgba(168,85,247,0.3)" : status === "high" ? "rgba(239,68,68,0.3)" : "rgba(59,130,246,0.3)"}`,
  }),
  metricsCards: { display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))", gap: 10, marginBottom: 16 },
  mCard: { background: "rgba(255,255,255,0.03)", border: "1px solid #1e2230", borderRadius: 8, padding: 13 },
  mCardTitle: { fontSize: "0.66rem", fontFamily: "monospace", color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 6 },
  mCardVal: (color) => ({ fontSize: "1.35rem", fontWeight: 900, fontFamily: "monospace", color, marginBottom: 3 }),
  mCardChange: { fontSize: "0.72rem", fontFamily: "monospace", marginBottom: 4 },
  mCardTarget: { fontSize: "0.66rem", color: "#6b7280", fontFamily: "monospace" },
  bar: { height: 4, background: "#1e2230", borderRadius: 2, marginTop: 6, overflow: "hidden" },
  barFill: (pct, color) => ({ height: "100%", width: `${Math.min(100, Math.max(0, pct))}%`, background: color, borderRadius: 2, transition: "width 0.5s" }),
  summary: { background: "rgba(168,85,247,0.06)", borderRadius: 8, padding: 14, fontSize: "0.82rem", lineHeight: 1.65, borderLeft: "3px solid #a855f7" },
};

// ─── MAIN ─────────────────────────────────────────────────────────────────────
export default function App() {
  const now = new Date();
  const [year, setYear]         = useState(now.getFullYear());
  const [month, setMonth]       = useState(now.getMonth());
  const [cache, setCache]       = useState({});
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState(null);
  const [selected, setSelected] = useState(null);

  const cacheKey = `${year}-${month}`;
  const dayData  = cache[cacheKey] || {};

  const loadMonth = useCallback(async (y, m) => {
    const key = `${y}-${m}`;
    if (cache[key]) return;
    setLoading(true); setError(null);
    try {
      const data = await fetchMonthData(y, m);
      setCache(prev => ({ ...prev, [key]: data }));
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [cache]);

  useEffect(() => { loadMonth(year, month); }, [year, month]);

  const today = new Date(); today.setHours(0, 0, 0, 0);

  function goPrev() {
    setSelected(null);
    if (month === 0) { setYear(y => y - 1); setMonth(11); }
    else setMonth(m => m - 1);
  }
  function goNext() {
    const nm = month === 11 ? 0 : month + 1;
    const ny = month === 11 ? year + 1 : year;
    if (new Date(ny, nm, 1) > today) return;
    setSelected(null); setYear(ny); setMonth(nm);
  }

  const firstDay = new Date(year, month, 1).getDay();
  const daysInMo = new Date(year, month + 1, 0).getDate();
  const allDates = Object.keys(dayData).sort();

  function getInfo(dateStr) {
    const raw = dayData[dateStr];
    if (!raw) return null;
    const idx = allDates.indexOf(dateStr);
    const prevRaw = idx > 0 ? dayData[allDates[idx - 1]] : null;
    const cur  = calcDay(raw);
    const prev = calcDay(prevRaw);
    const delta = (cur?.composite != null && prev?.composite != null) ? cur.composite - prev.composite : null;
    return { ...cur, calStatus: cur?.status, delta, prevRaw };
  }

  const selInfo = selected ? getInfo(selected) : null;
  const dotColor = loading ? "#fbbf24" : error ? "#ef4444" : "#22c55e";
  const statusMsg = loading ? "Fetching data from Open-Meteo…"
    : error ? `Error: ${error.slice(0, 100)}`
    : "Live · Historical Forecast API · Toronto 43.7°N 79.4°W";

  return (
    <div style={S.app}>
      <style>{`
        @keyframes spin { to { transform: rotate(360deg) } }
        * { box-sizing: border-box; margin: 0; padding: 0 }
        button:hover { border-color: #a855f7 !important; }
      `}</style>

      <div style={S.header}>
        <h1 style={S.h1}>Toronto God Dial</h1>
        <p style={S.sub}>Jet Stream Atmospheric Analysis — Is the dial too high, too low, or just right?</p>
      </div>

      <div style={S.statusBar}>
        <div style={S.dot(dotColor)} />
        <span>{statusMsg}</span>
      </div>

      <div style={S.legend}>
        <div style={S.legendTitle}>Calendar Color Guide</div>
        {[
          { c:"#ef4444", emoji:"⬆️", title:"Red — Dial Too High / Over-Amplified", desc:"Jet accelerating past target, Rossby wave amplifying, geopotential dropping. Cold trough digging over Toronto." },
          { c:"#3b82f6", emoji:"⬇️", title:"Blue — Dial Too Low / Collapsed",      desc:"Jet collapsed below threshold, low pressure stalling. Stuck cold or stagnant pattern over Toronto." },
          { c:"#a855f7", emoji:"🟣", title:"Purple — In Target Range",              desc:"All dials near optimal. Jet 130–185 km/h, geo ≥9350 m, SLP ≥1015 hPa. Progressive west-east flow." },
        ].map(({ c, emoji, title, desc }) => (
          <div key={title} style={S.legendItem}>
            <div style={S.legendDot(c)} />
            <div>
              <div style={{ fontWeight:700, fontSize:"0.78rem", marginBottom:2 }}>{emoji} {title}</div>
              <div style={{ color:"#6b7280", fontSize:"0.7rem", lineHeight:1.4 }}>{desc}</div>
            </div>
          </div>
        ))}
      </div>

      <div style={S.metricsBox}>
        <div style={S.metricsTitle}>Data Sources — Open-Meteo Historical Forecast API (Free · No Key Required)</div>
        <div style={S.metricsGrid}>
          {Object.entries(TARGETS).map(([k, t]) => (
            <div key={k} style={S.metricItem}>
              <div style={S.metricItemLabel}>{t.label}</div>
              <div style={S.metricItemDesc}>Target: {t.min}–{t.max} {t.unit} · Ideal: {t.ideal} {t.unit}</div>
            </div>
          ))}
          <div style={S.metricItem}>
            <div style={S.metricItemLabel}>Composite Score (0–100)</div>
            <div style={S.metricItemDesc}>Average of all 5 metrics. 55–75 = 🟣 purple. &lt;55 = 🔵 blue. &gt;75 = 🔴 red.</div>
          </div>
        </div>
      </div>

      <div style={S.calNav}>
        <button style={S.navBtn} onClick={goPrev}>← Prev</button>
        <span style={S.calTitle}>{MONTH_NAMES[month]} {year}</span>
        <button style={S.navBtn} onClick={goNext}>Next →</button>
      </div>

      <div style={S.calWrap}>
        <div style={S.calHead}>
          {DAY_NAMES.map(d => <div key={d} style={S.calHeadCell}>{d}</div>)}
        </div>
        <div style={S.calGrid}>
          {Array.from({ length: firstDay }).map((_, i) => (
            <div key={`e${i}`} style={{ ...S.dayCell(null,false,true,false), borderRight:"1px solid #1e2230", borderBottom:"1px solid #1e2230" }} />
          ))}
          {Array.from({ length: daysInMo }).map((_, i) => {
            const day = i + 1;
            const pad = n => String(n).padStart(2, "0");
            const dateStr = `${year}-${pad(month+1)}-${pad(day)}`;
            const cellDate = new Date(year, month, day);
            const isFuture = cellDate > today;
            const info = !isFuture ? getInfo(dateStr) : null;
            const isSel = selected === dateStr;
            const arrow = !info ? null : info.calStatus === "perfect" ? "🟣" : info.calStatus === "high" ? "⬆️" : "⬇️";

            return (
              <div key={dateStr} style={S.dayCell(info?.calStatus, isSel, false, isFuture)}
                onClick={() => { if (!isFuture && info) setSelected(dateStr === selected ? null : dateStr); }}>
                <div style={S.dayNum(info?.calStatus ?? "none")}>{day}</div>
                {loading && !info && <div style={{ width:12, height:12, border:"2px solid #1e2230", borderTopColor:"#a855f7", borderRadius:"50%", animation:"spin 0.8s linear infinite" }} />}
                {info && <div style={S.dayArrow}>{arrow}</div>}
                {info?.composite != null && <div style={S.dayScore(info.calStatus)}>{info.composite}/100</div>}
                {!info && !loading && !isFuture && <div style={{ fontSize:"0.58rem", color:"#4b5563", fontFamily:"monospace" }}>no data</div>}
              </div>
            );
          })}
        </div>
      </div>

      {selected && selInfo && (() => {
        const d = new Date(selected + "T12:00:00");
        const label = d.toLocaleDateString("en-CA", { weekday:"long", year:"numeric", month:"long", day:"numeric" });
        const status = selInfo.calStatus;
        const badgeText = status === "perfect" ? "🟣 In Target Range" : status === "high" ? "⬆️ Dial Too High" : "⬇️ Dial Too Low";

        return (
          <div style={S.detail}>
            <div style={S.detailHeader}>
              <div style={S.detailDate}>{label}</div>
              <div style={S.badge(status)}>{badgeText}</div>
            </div>
            <div style={S.metricsCards}>
              {Object.entries(TARGETS).map(([k, t]) => {
                const val = selInfo.raw?.[k];
                const prevVal = selInfo.prevRaw?.[k];
                const diff = val != null && prevVal != null ? val - prevVal : null;
                const diffStr = diff == null ? "—" : diff >= 0 ? `+${diff.toFixed(1)}` : diff.toFixed(1);
                const diffArrow = diff == null ? "→" : diff > 0.3 ? "↑" : diff < -0.3 ? "↓" : "→";
                const diffColor = diff == null ? "#6b7280" : diff > 0.3 ? "#ef4444" : diff < -0.3 ? "#3b82f6" : "#6b7280";
                const color = metricColor(k, val);
                const pct = barPct(k, val);
                return (
                  <div key={k} style={S.mCard}>
                    <div style={S.mCardTitle}>{t.label}</div>
                    <div style={S.mCardVal(color)}>{val != null ? val.toFixed(k === "geo300" ? 0 : 1) : "N/A"} <span style={{ fontSize:"0.75rem" }}>{t.unit}</span></div>
                    <div style={S.mCardChange}><span style={{ color: diffColor }}>{diffArrow} {diffStr} {t.unit} vs prev day</span></div>
                    <div style={S.mCardTarget}>Target: {t.min}–{t.max} {t.unit} · Ideal: {t.ideal}</div>
                    <div style={S.bar}><div style={S.barFill(pct, color)} /></div>
                  </div>
                );
              })}
            </div>
            <div style={S.summary}>{buildSummary(selInfo)}</div>
          </div>
        );
      })()}
    </div>
  );
}
