import { useState, useEffect, useCallback } from "react";

// ── LOCATIONS ────────────────────────────────────────────────────────────────
// Toronto: primary GodDial location
// Vancouver: Pacific jet entry point into North America (upstream)
// Winnipeg: mid-continent trough/ridge position detector (upstream)
// Hudson Bay (60N,80W): arctic high clamp detector (blocking high source)
// Halifax: downstream exit / Atlantic cutoff low detector
const LOCS = {
  toronto:   { lat: 43.7,  lon: -79.42, label: "Toronto" },
  vancouver: { lat: 49.25, lon: -123.1, label: "Vancouver (upstream)" },
  winnipeg:  { lat: 49.9,  lon: -97.14, label: "Winnipeg (mid-continent)" },
  hudson:    { lat: 60.0,  lon: -80.0,  label: "Hudson Bay (arctic clamp)" },
  halifax:   { lat: 44.65, lon: -63.57, label: "Halifax (downstream)" },
};

// ── UNIT HELPERS ─────────────────────────────────────────────────────────────
const hpaToInhg = v => v != null ? +(v * 0.02953).toFixed(3) : null;
const fmtInhg   = v => v != null ? v.toFixed(2) : "N/A";
const fmtVal    = (k, v) => {
  if (v == null) return "N/A";
  if (k === "pressure") return fmtInhg(hpaToInhg(v));
  if (k === "geo300" || k === "geo500" || k === "thickness") return Math.round(v).toString();
  if (k === "dir300" || k === "dir200") return Math.round(v) + "°";
  return v.toFixed(1);
};
const unitLabel = k => ({
  wind200:"km/h", wind250:"km/h", wind300:"km/h", wind500:"km/h",
  geo300:"m", geo500:"m", pressure:"inHg",
  temp850:"°C", temp500:"°C",
  dir300:"°", dir200:"°",
  thickness:"m",
}[k] || "");

// ── API VARIABLE NAMES ───────────────────────────────────────────────────────
// wind_speed_NhPa IS the same as "jet" at that level — it is the wind vector magnitude
// at that pressure surface. Ventusky discrepancy is due to their display smoothing.
// We use max daily to match Ventusky's "peak jet" display approach.
const TORONTO_VARS = [
  "wind_speed_200hPa",           // jet core summer level ~12km
  "wind_speed_250hPa",           // jet core gap-filler ~10.4km
  "wind_speed_300hPa",           // jet steering level ~9km
  "wind_speed_500hPa",           // mid-level steering ~5.6km (renamed to "500 hPa Jet")
  "geopotential_height_300hPa",  // trough/ridge at jet level
  "geopotential_height_500hPa",  // primary trough/ridge indicator
  "temperature_850hPa",          // air mass fingerprint ~1.5km
  "temperature_500hPa",          // cold core trough indicator ~5.6km
  "wind_direction_300hPa",       // flow direction at steering level
  "wind_direction_200hPa",       // flow direction at jet core
  "pressure_msl",                // sea level pressure (CORRECTED from surface_pressure)
  "geopotential_height_850hPa",  // for thickness calculation
];

// Upstream/downstream nodes only need geo500 + wind300 + pressure_msl
const GEO_VARS = [
  "geopotential_height_500hPa",
  "wind_speed_300hPa",
  "pressure_msl",
];

const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const DAYS   = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];

// ── FETCH ────────────────────────────────────────────────────────────────────
async function fetchLocation(lat, lon, vars, year, month) {
  const pad = n => String(n).padStart(2,"0");
  const start = `${year}-${pad(month+1)}-01`;
  const lastDay = new Date(year, month+1, 0).getDate();
  const end = `${year}-${pad(month+1)}-${pad(lastDay)}`;
  const url = `https://historical-forecast-api.open-meteo.com/v1/forecast`
    + `?latitude=${lat}&longitude=${lon}`
    + `&start_date=${start}&end_date=${end}`
    + `&hourly=${vars.join(",")}`
    + `&wind_speed_unit=kmh&timezone=America%2FToronto`;
  const res = await fetch(url);
  if (!res.ok) { const t = await res.text(); throw new Error(`API ${res.status}: ${t.slice(0,100)}`); }
  return res.json();
}

function parseJSON(json, varList) {
  const h = json.hourly;
  const byDate = {};
  h.time.forEach((t, i) => {
    const date = t.split("T")[0];
    if (!byDate[date]) byDate[date] = {};
    varList.forEach(v => {
      if (!byDate[date][v]) byDate[date][v] = [];
      const val = h[v]?.[i];
      if (val != null && !isNaN(val)) byDate[date][v].push(val);
    });
  });
  const result = {};
  Object.entries(byDate).forEach(([date, arrs]) => {
    result[date] = {};
    varList.forEach(v => {
      const a = arrs[v] || [];
      if (!a.length) { result[date][v] = null; return; }
      // Wind speeds → max (matches Ventusky peak display)
      // Temperatures, heights, pressure → avg
      const isWind = v.startsWith("wind_speed");
      result[date][v] = isWind
        ? Math.max(...a)
        : a.reduce((x,y)=>x+y,0)/a.length;
    });
  });
  return result;
}

async function fetchMonthAll(year, month) {
  // Throttle API calls to avoid 429 errors
  const delay = (ms) => new Promise(r => setTimeout(r, ms));
  // Parallel fetch: Toronto + 4 geo nodes
  const [torJson, vanJson, winJson, hudJson, halJson] = await Promise.all([
    (async () => { await delay(0); return await fetchLocation(LOCS.toronto.lat, LOCS.toronto.lon, TORONTO_VARS, year, month); })(),
    (async () => { await delay(150); return await fetchLocation(LOCS.vancouver.lat, LOCS.vancouver.lon, GEO_VARS, year, month); })(),
    (async () => { await delay(300); return await fetchLocation(LOCS.winnipeg.lat, LOCS.winnipeg.lon, GEO_VARS, year, month); })(),
    (async () => { await delay(450); return await fetchLocation(LOCS.hudson.lat, LOCS.hudson.lon, GEO_VARS, year, month); })(),
    (async () => { await delay(600); return await fetchLocation(LOCS.halifax.lat, LOCS.halifax.lon, GEO_VARS, year, month); })(),
  ]);

  const tor = parseJSON(torJson, TORONTO_VARS);
  const van = parseJSON(vanJson, GEO_VARS);
  const win = parseJSON(winJson, GEO_VARS);
  const hud = parseJSON(hudJson, GEO_VARS);
  const hal = parseJSON(halJson, GEO_VARS);

  // Merge into per-day combined object
  const allDates = Object.keys(tor);
  const merged = {};
  allDates.forEach(date => {
    const t = tor[date];
    // Derived: atmospheric thickness 850-500 hPa layer (warm=high, cold=low)
    const geo850 = t["geopotential_height_850hPa"];
    const geo500 = t["geopotential_height_500hPa"];
    const thickness = (geo850 != null && geo500 != null) ? geo500 - geo850 : null;

    // Derived: jet coherence ratio 200/500 (well-organized vs diffuse)
    const w200 = t["wind_speed_200hPa"];
    const w500 = t["wind_speed_500hPa"];
    const jetRatio = (w200 != null && w500 != null && w500 > 0) ? w200/w500 : null;

    // Derived: direction consistency 200 vs 300 hPa (deg diff)
    const dir200 = t["wind_direction_200hPa"];
    const dir300 = t["wind_direction_300hPa"];
    let dirDiff = null;
    if (dir200 != null && dir300 != null) {
      dirDiff = Math.abs(dir200 - dir300);
      if (dirDiff > 180) dirDiff = 360 - dirDiff;
    }

    merged[date] = {
      // Toronto primary
      wind200:   w200,
      wind250:   t["wind_speed_250hPa"],
      wind300:   t["wind_speed_300hPa"],
      wind500:   w500,
      geo300:    t["geopotential_height_300hPa"],
      geo500:    geo500,
      temp850:   t["temperature_850hPa"],
      temp500:   t["temperature_500hPa"],
      dir300:    dir300,
      dir200:    dir200,
      pressure:  t["pressure_msl"],
      // Derived
      thickness: thickness,
      jetRatio:  jetRatio,
      dirDiff:   dirDiff,
      // Geo nodes (geo500 + wind300 + pressure_msl)
      van_geo500:    van[date]?.["geopotential_height_500hPa"],
      van_wind300:   van[date]?.["wind_speed_300hPa"],
      win_geo500:    win[date]?.["geopotential_height_500hPa"],
      hud_pressure:  hud[date]?.["pressure_msl"],
      hal_geo500:    hal[date]?.["geopotential_height_500hPa"],
    };
  });
  return merged;
}

// ── SCORING ENGINE ───────────────────────────────────────────────────────────
// Every metric returns a signed "pinch delta" added to the composite.
// POSITIVE delta = evidence of flow COMPRESSION/PINCH (dial too high)
// NEGATIVE delta = evidence of flow EXPANSION (dial too low)
// Final composite = 65 (neutral) + sum of all deltas, clamped 0–100
// Score > 75 = too high (pinched), 50–75 = optimal range, < 50 = too low (expanded)

function scoringEngine(d) {
  const details = {};
  let totalDelta = 0;

  // Helper: clamp delta to maxMag
  const addDelta = (key, delta, maxMag, label, desc) => {
    const clamped = Math.max(-maxMag, Math.min(maxMag, delta));
    details[key] = { delta: clamped, label, desc, raw: d[key] };
    totalDelta += clamped;
  };

  // ── TORONTO PRIMARY METRICS ──────────────────────────────────────────────

  // 1. 300 hPa Jet Speed (weight 12)
  // Too fast = over-pressured pipe pinching | Too slow = no pressure
  if (d.wind300 != null) {
    // Optimal 130-185. >185 = pinch (+). <130 = expansion (-).
    const v = d.wind300;
    let delta = 0;
    if (v > 185)      delta = +Math.min(12, ((v-185)/30)*12);
    else if (v < 130) delta = -Math.min(12, ((130-v)/50)*12);
    else              delta = ((v-130)/(185-130)-0.5)*4; // small +/- within range
    addDelta("wind300", delta, 12, "300 hPa Jet (9km)", `${v.toFixed(1)} km/h — target 130–185`);
  }

  // 2. 200 hPa Jet Speed (weight 10)
  if (d.wind200 != null) {
    const v = d.wind200;
    let delta = 0;
    if (v > 210)      delta = +Math.min(10, ((v-210)/40)*10);
    else if (v < 130) delta = -Math.min(10, ((130-v)/50)*10);
    else              delta = ((v-130)/(210-130)-0.5)*3;
    addDelta("wind200", delta, 10, "200 hPa Jet (12km)", `${v.toFixed(1)} km/h — target 130–210`);
  }

  // 3. 250 hPa Jet Speed (weight 6) — gap-filler between 200 and 300
  if (d.wind250 != null) {
    const v = d.wind250;
    let delta = 0;
    if (v > 195)      delta = +Math.min(6, ((v-195)/35)*6);
    else if (v < 130) delta = -Math.min(6, ((130-v)/50)*6);
    else              delta = ((v-130)/(195-130)-0.5)*2;
    addDelta("wind250", delta, 6, "250 hPa Jet (10.4km)", `${v.toFixed(1)} km/h — target 130–195`);
  }

  // 4. 500 hPa Jet / Mid-level Steering (weight 6)
  // Renamed from "500 hPa Wind" — same variable wind_speed_500hPa
  if (d.wind500 != null) {
    const v = d.wind500;
    let delta = 0;
    if (v > 140)      delta = +Math.min(6, ((v-140)/40)*6);
    else if (v < 55)  delta = -Math.min(6, ((55-v)/35)*6);
    else              delta = ((v-55)/(140-55)-0.5)*2;
    addDelta("wind500", delta, 6, "500 hPa Jet (5.6km)", `${v.toFixed(1)} km/h — target 55–140`);
  }

  // 5. 300 hPa Geopotential Height (weight 8)
  // Low = deep cold trough = pinch. High = ridge = depends on jet speed.
  if (d.geo300 != null) {
    const v = d.geo300;
    let delta = 0;
    if (v < 9200)      delta = +Math.min(8, ((9200-v)/150)*8); // deep trough = pinch
    else if (v > 9500) delta = -Math.min(8, ((v-9500)/100)*8); // strong ridge = expansion
    else               delta = -((v-9200)/(9500-9200)-0.5)*3;  // small correction within range
    addDelta("geo300", delta, 8, "300 hPa GeoHeight (9km)", `${Math.round(v)} m — normal 9350–9450`);
  }

  // 6. 500 hPa Geopotential Height Toronto (weight 10) — PRIMARY trough/ridge
  // May normal ~5640–5700m. <5500 = deep trough = pinch. >5750 = blocking ridge.
  if (d.geo500 != null) {
    const v = d.geo500;
    let delta = 0;
    if (v < 5500)      delta = +Math.min(10, ((5500-v)/150)*10);
    else if (v > 5760) delta = -Math.min(10, ((v-5760)/100)*8);
    else               delta = -((v-5500)/(5760-5500)-0.5)*4;
    addDelta("geo500", delta, 10, "500 hPa GeoHeight (5.6km)", `${Math.round(v)} m — normal 5640–5700`);
  }

  // 7. 850 hPa Temperature at Toronto (weight 8) — air mass fingerprint
  // May normal ~4–10°C. Below 0 = cold air mass = pinch from polar side.
  // Above 12 = warm ridge = possibly too low/stagnant.
  if (d.temp850 != null) {
    const v = d.temp850;
    let delta = 0;
    if (v < 0)        delta = +Math.min(8, ((0-v)/6)*8);    // cold airmass = pinch
    else if (v > 12)  delta = -Math.min(8, ((v-12)/5)*6);   // warm stagnant ridge = expansion
    else              delta = -((v-0)/(12-0)-0.5)*3;
    addDelta("temp850", delta, 8, "850 hPa Temp (1.5km)", `${v.toFixed(1)}°C — May optimal 4–10°C`);
  }

  // 8. 500 hPa Temperature at Toronto (weight 6) — cold core trough detector
  // May normal ~-16 to -20°C. Colder than -24 = deep cold core = pinch.
  if (d.temp500 != null) {
    const v = d.temp500;
    let delta = 0;
    if (v < -24)       delta = +Math.min(6, ((-24-v)/5)*6);
    else if (v > -12)  delta = -Math.min(6, ((v+12)/4)*4);
    else               delta = -((v+24)/(12)-0.5)*2;
    addDelta("temp500", delta, 6, "500 hPa Temp (5.6km)", `${v.toFixed(1)}°C — May normal -16 to -20°C`);
  }

  // 9. Sea Level Pressure at Toronto (weight 6) — surface confirmation
  // Too low = active cyclone = pinch-driven chaos. Too high (>1025 + arctic) = clamp.
  if (d.pressure != null) {
    const v = d.pressure;
    let delta = 0;
    if (v < 1008)      delta = +Math.min(6, ((1008-v)/8)*6);  // active low = pinch
    else if (v > 1025) delta = +Math.min(6, ((v-1025)/5)*4);  // arctic high = clamp = also pinch
    else               delta = -((v-1008)/(1025-1008)-0.5)*2;
    addDelta("pressure", delta, 6, "Sea Level Pressure", `${fmtInhg(hpaToInhg(v))} inHg — optimal 29.78–30.27`);
  }

  // 10. Atmospheric Thickness 850-500 hPa (weight 6) — warm/cold column
  // Warm column = high thickness >5700m = expansion (mild stagnant ridge)
  // Cold column = low thickness <5400m = compression/pinch
  if (d.thickness != null) {
    const v = d.thickness;
    let delta = 0;
    if (v < 5400)      delta = +Math.min(6, ((5400-v)/100)*6);
    else if (v > 5720) delta = -Math.min(6, ((v-5720)/100)*5);
    else               delta = -((v-5400)/(5720-5400)-0.5)*2;
    addDelta("thickness", delta, 6, "Thickness 850–500hPa", `${Math.round(v)} m — warm >5700, cold <5400`);
  }

  // 11. Jet Coherence Ratio 200÷500 hPa (weight 4) — organized vs diffuse jet
  // >2.5 = well-organized jet = good flow (expansion)
  // <1.5 = diffuse/chaotic = either kinked or collapsed
  if (d.jetRatio != null) {
    const v = d.jetRatio;
    let delta = 0;
    if (v < 1.5)      delta = +Math.min(4, ((1.5-v)/0.5)*4); // diffuse = disordered = pinch-adjacent
    else if (v > 2.5) delta = -Math.min(4, ((v-2.5)/1.0)*4); // well-organized = expansion
    addDelta("jetRatio", delta, 4, "Jet Coherence (200÷500)", `${v.toFixed(2)} ratio — optimal >2.5`);
  }

  // 12. Wind Direction at 300 hPa (weight 5) — flow quality
  // SW (210-270°) = warm advection, optimal flow = expansion
  // NW (290-350°) = cold post-frontal = pinch signal
  // N/NE = arctic = strong pinch
  if (d.dir300 != null) {
    const v = d.dir300;
    let delta = 0;
    // SW quadrant optimal
    if (v >= 210 && v <= 270)      delta = -Math.min(5, 5);    // pure optimal expansion
    else if (v >= 270 && v <= 310) delta = 0;                   // neutral westerly
    else if (v >= 310 && v <= 360) delta = +Math.min(5, ((v-310)/50)*5); // NW = pinch
    else if (v >= 0 && v <= 60)    delta = +Math.min(5, 5);    // N/NE = arctic = max pinch
    else if (v >= 160 && v <= 210) delta = -Math.min(3, 3);    // SSW = warm sector
    addDelta("dir300", delta, 5, "300 hPa Flow Direction", `${Math.round(v)}° — SW(210-270°)=optimal, N/NW=pinch`);
  }

  // 13. Direction Consistency 200 vs 300 hPa (weight 3) — coherence check
  // <20° = coherent layered flow = expansion (good)
  // >60° = directional shear = chaotic = pinch-adjacent
  if (d.dirDiff != null) {
    const v = d.dirDiff;
    let delta = 0;
    if (v > 60)       delta = +Math.min(3, ((v-60)/40)*3);
    else if (v < 20)  delta = -Math.min(3, ((20-v)/20)*3);
    addDelta("dirDiff", delta, 3, "Dir Coherence (200 vs 300)", `${Math.round(v)}° diff — <20°=coherent, >60°=shear`);
  }

  // ── GEOGRAPHIC NODE METRICS ──────────────────────────────────────────────

  // 14. Vancouver 300 hPa Jet — upstream pipe pressure
  // Strong jet entering NA from Pacific = good flow = expansion
  // Weak = collapsing upstream = dial too low incoming
  if (d.van_wind300 != null) {
    const v = d.van_wind300;
    let delta = 0;
    if (v > 200)      delta = +Math.min(4, ((v-200)/30)*4);  // over-pressured upstream
    else if (v < 100) delta = -Math.min(4, ((100-v)/50)*4);  // collapsed upstream
    addDelta("van_wind300", delta, 4, "Vancouver 300hPa Jet (upstream)", `${v.toFixed(1)} km/h — Pacific jet entry`);
  }

  // 15. Vancouver 500 hPa Geo Height — upstream trough/ridge
  // Low = trough moving toward Toronto in 24-48h = incoming pinch
  if (d.van_geo500 != null) {
    const v = d.van_geo500;
    let delta = 0;
    if (v < 5500)      delta = +Math.min(5, ((5500-v)/150)*5); // trough approaching
    else if (v > 5760) delta = -Math.min(5, ((v-5760)/100)*4); // ridge upstream = good
    addDelta("van_geo500", delta, 5, "Vancouver 500hPa Geo (upstream trough)", `${Math.round(v)} m`);
  }

  // 16. Winnipeg 500 hPa Geo — mid-continent trough position
  // If Winnipeg << Toronto: trough is west of Toronto = incoming
  // If Winnipeg >> Toronto: trough east of Toronto = clearing
  if (d.win_geo500 != null && d.geo500 != null) {
    const diff = d.win_geo500 - d.geo500; // positive = Winnipeg higher = ridge to west
    let delta = 0;
    if (diff < -80)   delta = +Math.min(5, ((-80-diff)/100)*5); // deep trough west = incoming pinch
    else if (diff > 80) delta = -Math.min(5, ((diff-80)/100)*4); // ridge west = expansion
    addDelta("win_geo500", delta, 5, "Winnipeg–Toronto Geo Diff (trough position)", `${Math.round(diff)} m diff`);
  }

  // 17. Hudson Bay Pressure — arctic high clamp detector
  // >1030 hPa at 60N = arctic high = THE primary clamp mechanism
  if (d.hud_pressure != null) {
    const v = d.hud_pressure;
    let delta = 0;
    if (v > 1030)      delta = +Math.min(6, ((v-1030)/6)*6);  // arctic high = clamp = pinch
    else if (v < 1010) delta = -Math.min(3, ((1010-v)/8)*3);  // low pressure north = relief
    addDelta("hud_pressure", delta, 6, "Hudson Bay Pressure (arctic clamp)", `${fmtInhg(hpaToInhg(v))} inHg at 60°N`);
  }

  // 18. Halifax 500 hPa Geo — downstream exit detector
  // Low = cutoff low forming Atlantic = pulling trough back over Toronto = pinch sustaining
  // High = exit ridge = systems flowing out cleanly = expansion
  if (d.hal_geo500 != null) {
    const v = d.hal_geo500;
    let delta = 0;
    if (v < 5500)       delta = +Math.min(4, ((5500-v)/150)*4); // Atlantic cutoff = sustained pinch
    else if (v > 5720)  delta = -Math.min(4, ((v-5720)/100)*3); // exit ridge = systems leaving
    addDelta("hal_geo500", delta, 4, "Halifax 500hPa Geo (downstream exit)", `${Math.round(v)} m`);
  }

  // ── COMPOSITE ────────────────────────────────────────────────────────────
  // Neutral baseline = 62 (slightly below midpoint — atmosphere has slight expansion bias in May)
  // Each delta pushes toward pinch (higher) or expansion (lower)
  const composite = Math.round(Math.max(0, Math.min(100, 62 + totalDelta)));

  // Status thresholds:
  // >72 = TOO HIGH (pinched) — multiple compression signals
  // 48–72 = OPTIMAL — balanced flow
  // <48 = TOO LOW (expanded) — collapsed/stagnant
  const status = composite > 72 ? "high" : composite < 48 ? "low" : "perfect";

  return { composite, status, details, totalDelta };
}

// ── COLORS & HELPERS ─────────────────────────────────────────────────────────
const C = {
  high:"#ef4444", low:"#3b82f6", perfect:"#a855f7",
  bg:"#0d0f14", panel:"#13161e", border:"#1e2230", text:"#e4e8f0", muted:"#6b7280"
};
const sc = s => s==="perfect"?C.perfect:s==="high"?C.high:s==="low"?C.low:C.muted;

function buildSummary(status, d, composite, details) {
  const topPinch = Object.entries(details)
    .filter(([,v])=>v.delta>2).sort((a,b)=>b[1].delta-a[1].delta).slice(0,3)
    .map(([,v])=>v.label+" ("+v.desc+")").join("; ");
  const topExpand = Object.entries(details)
    .filter(([,v])=>v.delta<-2).sort((a,b)=>a[1].delta-b[1].delta).slice(0,3)
    .map(([,v])=>v.label+" ("+v.desc+")").join("; ");

  if (status==="high") return `Score ${composite}/100 — PIPE PINCHED over Toronto. Primary compression signals: ${topPinch||"multiple metrics elevated"}. ${topExpand?`Partial expansion relief from: ${topExpand}.`:""} God would ease amplitude and flatten the wave.`;
  if (status==="low")  return `Score ${composite}/100 — NO PIPE PRESSURE over Toronto. Primary expansion/collapse signals: ${topExpand||"multiple metrics suppressed"}. ${topPinch?`Some residual compression from: ${topPinch}.`:""} God would turn the dial up to 140–160 km/h to restore steering flow.`;
  return `Score ${composite}/100 — PIPE AT WORKING PRESSURE over Toronto. Flow balanced across ${Object.keys(details).length} metrics spanning Toronto to Vancouver. Systems steering east efficiently. God holds the dial here.`;
}

// ── MAIN APP ─────────────────────────────────────────────────────────────────
export default function App() {
  const now = new Date();
  const [year, setYear]         = useState(now.getFullYear());
  const [month, setMonth]       = useState(now.getMonth());
  const [cache, setCache]       = useState({});
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState(null);
  const [modalDay, setModalDay] = useState(null);

  const cacheKey = `${year}-${month}`;
  const dayData  = cache[cacheKey] || {};

  const loadMonth = useCallback(async (y, m) => {
    const key = `${y}-${m}`;
    if (cache[key]) return;
    setLoading(true); setError(null);
    try {
      const data = await fetchMonthAll(y, m);
      setCache(prev => ({ ...prev, [key]: data }));
    } catch(e) { setError(e.message); }
    finally { setLoading(false); }
  }, [cache]);

  useEffect(() => { loadMonth(year, month); }, [year, month]);

  const today = new Date(); today.setHours(0,0,0,0);
  const isCurrentMonth = year===today.getFullYear() && month===today.getMonth();
  const allDates = Object.keys(dayData).sort();

  function goPrev() { setModalDay(null); if(month===0){setYear(y=>y-1);setMonth(11);}else setMonth(m=>m-1); }
  function goNext() {
    if (isCurrentMonth) return;
    const nm=month===11?0:month+1, ny=month===11?year+1:year;
    if (new Date(ny,nm,1)>today) return;
    setModalDay(null); setYear(ny); setMonth(nm);
  }

  function getInfo(dateStr) {
    const raw = dayData[dateStr];
    if (!raw) return null;
    const result = scoringEngine(raw);
    const idx = allDates.indexOf(dateStr);
    const prevRaw = idx>0 ? dayData[allDates[idx-1]] : null;
    const prevResult = prevRaw ? scoringEngine(prevRaw) : null;
    const delta = result.composite!=null && prevResult?.composite!=null
      ? result.composite - prevResult.composite : null;
    return { ...result, delta, prevRaw };
  }

  const firstDay = new Date(year, month, 1).getDay();
  const daysInMo = new Date(year, month+1, 0).getDate();
  const totalCells = Math.ceil((firstDay+daysInMo)/7)*7;
  const dotColor = loading?"#fbbf24":error?"#ef4444":"#22c55e";
  const modalInfo = modalDay ? getInfo(modalDay) : null;

  return (
    <div style={{background:C.bg,height:"100vh",width:"100vw",color:C.text,fontFamily:"'Segoe UI',system-ui,sans-serif",display:"flex",flexDirection:"column",overflow:"hidden",padding:"6px 10px",boxSizing:"border-box"}}>
      <style>{`
        @keyframes spin{to{transform:rotate(360deg)}}
        *{box-sizing:border-box;margin:0;padding:0}
        html,body{height:100%;width:100%;overflow:hidden;background:${C.bg}}
        ::-webkit-scrollbar{width:3px}
        ::-webkit-scrollbar-thumb{background:#2d3148;border-radius:2px}
      `}</style>

      {/* HEADER */}
      <div style={{textAlign:"center",flexShrink:0,paddingBottom:1,marginTop:"-12px"}}>
        <h1 style={{fontSize:"clamp(1.1rem,2.5vw,1.7rem)",fontWeight:900,letterSpacing:"-0.03em",background:"linear-gradient(135deg,#fff 30%,#a855f7)",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent",backgroundClip:"text",lineHeight:1.1}}>
          Toronto God Dial
        </h1>
        <div style={{display:"flex",alignItems:"center",justifyContent:"center",gap:5,marginTop:2,fontFamily:"monospace",fontSize:"0.62rem",color:C.muted}}>
          <div style={{width:6,height:6,borderRadius:"50%",background:dotColor,boxShadow:`0 0 4px ${dotColor}`}}/>
          <span>{loading?"Fetching 5 locations from Open-Meteo (Vancouver→Toronto→Halifax)…":error?`Error: ${error.slice(0,70)}`:"Live · ERA5+GFS · 18 metrics · 5 locations · Vancouver→Winnipeg→Toronto→Hudson→Halifax"}</span>
        </div>
      </div>

      {/* INFO ROW */}
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:6,flexShrink:0,marginBottom:5}}>
        {/* Left: Reading guide */}
        <div style={{background:C.panel,border:`1px solid ${C.border}`,borderRadius:7,padding:"7px 10px",maxHeight:"18vh",overflowY:"auto"}}>
          <div style={{fontSize:"0.55rem",fontFamily:"monospace",color:C.muted,textTransform:"uppercase",letterSpacing:"0.1em",marginBottom:5}}>God Dial Reading Guide — 18 Metrics, 5 Locations</div>
          {[
            {c:C.high,  e:"🔴",t:"TOO HIGH — Pipe Pinched",    d:"Multiple compression signals: deep trough, cold air mass, NW flow, arctic high clamping, kinked jet. Chaotic stagnation."},
            {c:C.low,   e:"🔵",t:"TOO LOW — No Pressure",      d:"Multiple expansion signals: collapsed jet, warm stagnant ridge, SW flow absent, no upstream drive from Pacific."},
            {c:C.perfect,e:"🟣",t:"OPTIMAL — Working Pressure", d:"Balanced across all 18 metrics. Jet 130–185 km/h zonal, geo normal, SW flow, upstream Pacific drive, no arctic clamp."},
          ].map(({c,e,t,d})=>(
            <div key={t} style={{display:"flex",gap:6,alignItems:"flex-start",marginBottom:4}}>
              <div style={{width:7,height:7,borderRadius:2,background:c,flexShrink:0,marginTop:2}}/>
              <div>
                <div style={{fontWeight:700,fontSize:"0.67rem",lineHeight:1.2}}>{e} {t}</div>
                <div style={{color:C.muted,fontSize:"0.6rem",lineHeight:1.3}}>{d}</div>
              </div>
            </div>
          ))}
        </div>

        {/* Right: Data sources */}
        <div style={{background:C.panel,border:`1px solid ${C.border}`,borderRadius:7,padding:"7px 10px",maxHeight:"18vh",overflowY:"auto"}}>
          <div style={{fontSize:"0.55rem",fontFamily:"monospace",color:C.muted,textTransform:"uppercase",letterSpacing:"0.1em",marginBottom:5}}>
            Open-Meteo ERA5+GFS · 5 Fetch Points · Score = 62 + Σ(pinch deltas) → 0–100
          </div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"3px 8px"}}>
            {[
              {l:"200/250/300/500 hPa Jet",d:"Toronto — jet speeds at 4 levels"},
              {l:"300+500 hPa GeoHeight",  d:"Toronto — trough/ridge depth"},
              {l:"850+500 hPa Temp",       d:"Toronto — air mass + cold core"},
              {l:"300+200 hPa Direction",  d:"Toronto — flow type SW vs NW"},
              {l:"Thickness 850–500",      d:"Toronto — warm/cold column"},
              {l:"Jet Coherence 200÷500",  d:"Toronto — organized vs diffuse"},
              {l:"pressure_msl",           d:"Toronto — sea level (corrected)"},
              {l:"Vancouver 300hPa Jet",   d:"Upstream Pacific entry point"},
              {l:"Vancouver 500hPa Geo",   d:"Upstream trough approaching?"},
              {l:"Winnipeg–Toronto ΔGeo",  d:"Trough west or east of Toronto?"},
              {l:"Hudson Bay pressure",    d:"Arctic high clamp detector 60°N"},
              {l:"Halifax 500hPa Geo",     d:"Downstream exit or cutoff low?"},
            ].map(({l,d})=>(
              <div key={l} style={{background:"rgba(168,85,247,0.07)",borderRadius:4,padding:"3px 6px",borderLeft:`2px solid ${C.perfect}`}}>
                <div style={{fontWeight:700,fontSize:"0.6rem",lineHeight:1.2}}>{l}</div>
                <div style={{color:C.muted,fontFamily:"monospace",fontSize:"0.56rem"}}>{d}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* CALENDAR NAV */}
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",flexShrink:0,marginBottom:4}}>
        <button onClick={goPrev} style={{background:C.panel,border:`1px solid ${C.border}`,color:C.text,padding:"4px 12px",borderRadius:5,cursor:"pointer",fontFamily:"monospace",fontSize:"0.7rem"}}>← Prev</button>
        <span style={{fontSize:"0.95rem",fontWeight:700}}>{MONTHS[month]} {year}</span>
        <button onClick={goNext} disabled={isCurrentMonth} style={{background:C.panel,border:`1px solid ${C.border}`,color:isCurrentMonth?"#374151":C.text,padding:"4px 12px",borderRadius:5,cursor:isCurrentMonth?"not-allowed":"pointer",fontFamily:"monospace",fontSize:"0.7rem",opacity:isCurrentMonth?0.4:1}}>Next →</button>
      </div>

      {/* CALENDAR */}
      <div style={{flex:1,minHeight:0,background:C.panel,border:`1px solid ${C.border}`,borderRadius:7,overflow:"hidden",display:"flex",flexDirection:"column"}}>
        <div style={{display:"grid",gridTemplateColumns:"repeat(7,1fr)",background:"rgba(255,255,255,0.03)",borderBottom:`1px solid ${C.border}`,flexShrink:0}}>
          {DAYS.map(d=><div key={d} style={{padding:"4px 0",textAlign:"center",fontSize:"0.6rem",fontFamily:"monospace",color:C.muted,textTransform:"uppercase",letterSpacing:"0.05em"}}>{d}</div>)}
        </div>
        <div style={{flex:1,display:"grid",gridTemplateColumns:"repeat(7,1fr)",gridTemplateRows:`repeat(${totalCells/7},1fr)`,minHeight:0}}>
          {Array.from({length:firstDay}).map((_,i)=>(
            <div key={`e${i}`} style={{borderRight:`1px solid ${C.border}`,borderBottom:`1px solid ${C.border}`,background:"rgba(0,0,0,0.1)"}}/>
          ))}
          {Array.from({length:daysInMo}).map((_,i)=>{
            const day=i+1, pad=n=>String(n).padStart(2,"0");
            const dateStr=`${year}-${pad(month+1)}-${pad(day)}`;
            const isFuture=new Date(year,month,day)>today;
            const info=(!isFuture&&!loading)?getInfo(dateStr):null;
            const status=info?.status;
            const col=sc(status);
            const trendArrow=info?.delta==null?null:info.delta>2?"⬆️":info.delta<-2?"⬇️":"➡️";
            return(
              <div key={dateStr}
                onClick={()=>{ if(!isFuture&&info)setModalDay(dateStr===modalDay?null:dateStr); }}
                style={{borderRight:`1px solid ${C.border}`,borderBottom:`1px solid ${C.border}`,cursor:isFuture||!info?"default":"pointer",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:1,opacity:isFuture?0.2:1,background:isFuture?"transparent":status==="perfect"?"rgba(168,85,247,0.13)":status==="high"?"rgba(239,68,68,0.12)":status==="low"?"rgba(59,130,246,0.12)":"transparent",outline:modalDay===dateStr?`2px solid ${C.perfect}`:"none",outlineOffset:-2,overflow:"hidden"}}
              >
                <div style={{fontSize:"clamp(0.6rem,1vw,0.8rem)",fontWeight:700,fontFamily:"monospace",color:col,lineHeight:1}}>{day}</div>
                {loading&&!info&&<div style={{width:8,height:8,border:`1.5px solid ${C.border}`,borderTopColor:C.perfect,borderRadius:"50%",animation:"spin 0.8s linear infinite"}}/>}
                {info&&<div style={{fontSize:"clamp(0.7rem,1.2vw,1rem)",lineHeight:1}}>{status==="perfect"?"🟣":status==="high"?"🔴":"🔵"}</div>}
                {info?.composite!=null&&<div style={{fontSize:"clamp(0.45rem,0.7vw,0.58rem)",fontFamily:"monospace",color:col,lineHeight:1}}>{info.composite}/100</div>}
                {trendArrow&&<div style={{fontSize:"clamp(0.45rem,0.7vw,0.6rem)",lineHeight:1}}>{trendArrow}</div>}
                {!info&&!loading&&!isFuture&&<div style={{fontSize:"0.5rem",color:"#374151",fontFamily:"monospace"}}>—</div>}
              </div>
            );
          })}
          {Array.from({length:totalCells-(firstDay+daysInMo)}).map((_,i)=>(
            <div key={`f${i}`} style={{borderRight:`1px solid ${C.border}`,borderBottom:`1px solid ${C.border}`,background:"rgba(0,0,0,0.05)"}}/>
          ))}
        </div>
      </div>

      {/* MODAL */}
      {modalDay&&modalInfo&&(
        <div onClick={e=>{if(e.target===e.currentTarget)setModalDay(null);}} style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.85)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:1000,padding:12,backdropFilter:"blur(3px)"}}>
          <div style={{background:C.panel,border:`1px solid ${C.border}`,borderRadius:10,padding:16,width:"100%",maxWidth:780,maxHeight:"90vh",overflowY:"auto"}}>

            {/* Modal header */}
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:10,flexWrap:"wrap",gap:6}}>
              <div style={{fontSize:"0.95rem",fontWeight:800,letterSpacing:"-0.02em"}}>
                {new Date(modalDay+"T12:00:00").toLocaleDateString("en-CA",{weekday:"long",year:"numeric",month:"long",day:"numeric"})}
              </div>
              <div style={{display:"flex",alignItems:"center",gap:6}}>
                <div style={{padding:"3px 10px",borderRadius:14,fontSize:"0.72rem",fontWeight:700,
                  background:modalInfo.status==="perfect"?"rgba(168,85,247,0.15)":modalInfo.status==="high"?"rgba(239,68,68,0.12)":"rgba(59,130,246,0.12)",
                  color:sc(modalInfo.status),border:`1px solid ${sc(modalInfo.status)}55`}}>
                  {modalInfo.status==="perfect"?"🟣 Optimal":modalInfo.status==="high"?"🔴 Pinched — Too High":"🔵 Expanded — Too Low"}
                </div>
                <button onClick={()=>setModalDay(null)} style={{background:"rgba(255,255,255,0.07)",border:`1px solid ${C.border}`,color:C.text,width:26,height:26,borderRadius:5,cursor:"pointer",fontSize:"0.85rem",display:"flex",alignItems:"center",justifyContent:"center"}}>✕</button>
              </div>
            </div>

            {/* Score + trend */}
            <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:10,padding:"6px 10px",background:"rgba(255,255,255,0.03)",borderRadius:6,fontFamily:"monospace",fontSize:"0.7rem",flexWrap:"wrap"}}>
              <span style={{color:C.muted}}>Trend:</span>
              <span style={{fontWeight:700,color:modalInfo.delta==null?C.muted:modalInfo.delta>2?C.high:modalInfo.delta<-2?C.low:"#9ca3af"}}>
                {modalInfo.delta==null?"No prior data":modalInfo.delta>2?`⬆️ +${modalInfo.delta} pts`:modalInfo.delta<-2?`⬇️ ${modalInfo.delta} pts`:`➡️ ${modalInfo.delta>0?"+":""}${modalInfo.delta} pts`}
              </span>
              <span style={{color:C.muted,marginLeft:8}}>Score: <strong style={{color:C.text}}>{modalInfo.composite}/100</strong></span>
              <span style={{color:C.muted,marginLeft:8}}>Total Δ: <strong style={{color:modalInfo.totalDelta>0?C.high:C.low}}>{modalInfo.totalDelta>0?"+":""}{modalInfo.totalDelta.toFixed(1)}</strong></span>
              <span style={{color:C.muted,fontSize:"0.62rem",marginLeft:"auto"}}>18 metrics · 5 locations</span>
            </div>

            {/* Metric cards — all 18 */}
            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(165px,1fr))",gap:6,marginBottom:10}}>
              {Object.entries(modalInfo.details).map(([key,det])=>{
                const isPos = det.delta > 0.3;
                const isNeg = det.delta < -0.3;
                const col = isPos?C.high:isNeg?C.low:"#9ca3af";
                const bg = isPos?"rgba(239,68,68,0.06)":isNeg?"rgba(59,130,246,0.06)":"rgba(255,255,255,0.02)";
                return(
                  <div key={key} style={{background:bg,border:`1px solid ${C.border}`,borderRadius:6,padding:"8px 9px",borderLeft:`3px solid ${col}`}}>
                    <div style={{fontSize:"0.57rem",fontFamily:"monospace",color:C.muted,textTransform:"uppercase",letterSpacing:"0.05em",marginBottom:2}}>{det.label}</div>
                    <div style={{fontSize:"1.0rem",fontWeight:900,fontFamily:"monospace",color:col,marginBottom:1}}>
                      {fmtVal(key, det.raw)}<span style={{fontSize:"0.62rem",marginLeft:3}}>{unitLabel(key)}</span>
                    </div>
                    <div style={{fontSize:"0.58rem",color:col,fontWeight:700,marginBottom:2}}>
                      {isPos?"⬆ Compression +"+det.delta.toFixed(1):isNeg?"⬇ Expansion "+det.delta.toFixed(1):"→ Neutral"}
                    </div>
                    <div style={{fontSize:"0.56rem",color:C.muted,fontFamily:"monospace",lineHeight:1.3}}>{det.desc}</div>
                  </div>
                );
              })}
            </div>

            {/* Summary */}
            <div style={{background:"rgba(168,85,247,0.06)",borderRadius:6,padding:11,fontSize:"0.75rem",lineHeight:1.65,borderLeft:`3px solid ${C.perfect}`}}>
              {buildSummary(modalInfo.status, dayData[modalDay], modalInfo.composite, modalInfo.details)}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}            {/* RIGHT: Summary & Score Breakdown */}
            <div style={{flex:"0 0 35%",display:"flex",flexDirection:"column",alignItems:"flex-start",justifyContent:"flex-start",gap:8}}>
              <div style={{display:"flex",alignItems:"center",gap:6}}>
                <div style={{padding:"3px 10px",borderRadius:14,fontSize:"0.72rem",fontWeight:700,background:modalInfo.status==="perfect"?"rgba(168,85,247,0.15)":modalInfo.status==="high"?"rgba(239,68,68,0.12)":"rgba(59,130,246,0.12)",color:sc(modalInfo.status),border:`1px solid ${sc(modalInfo.status)}55`}}>
                  {modalInfo.status==="perfect"?"🟣 Optimal":modalInfo.status==="high"?"🔴 Too High — Pinched":"🔵 Too Low — No Pressure"}
                </div>
                <button onClick={()=>setModalDay(null)} style={{background:"rgba(255,255,255,0.07)",border:`1px solid ${C.border}`,color:C.text,width:24,height:24,borderRadius:5,cursor:"pointer",fontSize:"0.8rem",display:"flex",alignItems:"center",justifyContent:"center",marginLeft:"auto"}}>✕</button>
              </div>

              <div style={{background:"rgba(168,85,247,0.06)",borderRadius:6,padding:10,fontSize:"0.7rem",lineHeight:1.8,borderLeft:`3px solid ${C.perfect}`,flex:1,overflow:"auto"}}>
                <div style={{fontWeight:800,marginBottom:6,fontSize:"0.74rem"}}>Score Breakdown: {modalInfo.composite}/100</div>
                <div style={{color:C.muted,marginBottom:4,fontSize:"0.67rem"}}>Baseline: 62 + Σ(deltas) = {modalInfo.composite}</div>
                <div style={{color:modalInfo.totalDelta>0?C.high:C.low,marginBottom:8,fontSize:"0.68rem",fontWeight:700}}>Total Δ: {modalInfo.totalDelta>0?"+":""}​{modalInfo.totalDelta.toFixed(1)} pts</div>
                
                <div style={{fontSize:"0.67rem",fontWeight:700,color:"#a78bfa",marginBottom:5}}>Top 8 Contributors:</div>
                {Object.entries(modalInfo.details).sort((a,b)=>Math.abs(b[1].delta)-Math.abs(a[1].delta)).slice(0,8).map(([key,det])=>(
                  <div key={key} style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:3,fontSize:"0.66rem"}}>
                    <span style={{color:C.muted,flex:1}}>{det.label}</span>
                    <span style={{color:det.delta>0?C.high:det.delta<0?C.low:"#9ca3af",fontWeight:700,marginLeft:4}}>{det.delta>0?"+":""}​{det.delta.toFixed(1)}</span>
                  </div>
                ))}
                
                <div style={{marginTop:8,paddingTop:8,borderTop:`1px solid ${C.border}`,fontSize:"0.67rem",color:C.muted,lineHeight:1.6}}>
                  {buildSummary(modalInfo.status,dayData[modalDay],modalInfo.composite,modalInfo.details)}
                </div>
              </div>
            </div>            </div>
          </div>
        </div>
      )}
    </div>
  );
}