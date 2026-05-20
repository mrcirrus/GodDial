import { useState, useEffect, useCallback } from "react";

const LAT = 43.7, LON = -79.42;

const TARGETS = {
  wind300:  { min: 130, ideal: 145, max: 185, label: "300 hPa Wind",     unit: "km/h", key: "wind_speed_300hPa",          desc: "Steering-level wind speed (daily average)" },
  wind500:  { min: 55,  ideal: 95,  max: 140, label: "500 hPa Wind",     unit: "km/h", key: "wind_speed_500hPa",          desc: "Mid-level wind speed (daily average)" },
  geo300:   { min: 9200, ideal: 9390, max: 9500, label: "300 hPa Height", unit: "m",   key: "geopotential_height_300hPa", desc: "Trough/ridge indicator (daily average)" },
  pressure: { min: 1008, ideal: 1016, max: 1030, label: "Sea Level P",   unit: "hPa",  key: "pressure_msl",               desc: "Surface pressure (daily average)" },
};

const MONTH_NAMES = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const DAY_NAMES = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];

async function fetchMonthData(year, month) {
  const pad = n => String(n).padStart(2, "0");
  const start = `${year}-${pad(month+1)}-01`;
  const lastDay = new Date(year, month+1, 0).getDate();
  const end = `${year}-${pad(month+1)}-${pad(lastDay)}`;
  const pvars = ["wind_speed_300hPa","wind_speed_500hPa","geopotential_height_300hPa"].join(",");
  const url = `https://historical-forecast-api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LON}&start_date=${start}&end_date=${end}&hourly=${pvars},pressure_msl&wind_speed_unit=kmh&timezone=America%2FToronto`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`API ${res.status}: ${(await res.text()).slice(0,200)}`);
  return parseHourly(await res.json());
}

function parseHourly(json) {
  const h = json.hourly;
  if (!h || !h.time) throw new Error("Unexpected API response");
  const byDate = {};
  h.time.forEach((t, i) => {
    const date = t.split("T")[0];
    if (!byDate[date]) byDate[date] = { wind300:[], wind500:[], geo300:[], pressure:[] };
    const d = byDate[date];
    const push = (arr, val) => { if (val != null && !isNaN(val)) arr.push(val); };
    push(d.wind300,  h["wind_speed_300hPa"]?.[i]);
    push(d.wind500,  h["wind_speed_500hPa"]?.[i]);
    push(d.geo300,   h["geopotential_height_300hPa"]?.[i]);
    push(d.pressure, h["pressure_msl"]?.[i]);
  });
  const result = {};
  Object.entries(byDate).forEach(([date, arrs]) => {
    const avg = a => a.length ? a.reduce((x,y) => x+y,0)/a.length : null;
    result[date] = { wind300:avg(arrs.wind300), wind500:avg(arrs.wind500), geo300:avg(arrs.geo300), pressure:avg(arrs.pressure) };
  });
  return result;
}

function scoreMetric(key, val) {
  if (val == null) return null;
  const t = TARGETS[key];
  if (key === "geo300" || key === "pressure") {
    if (val < t.min) return Math.max(0, ((val-(t.min-300))/300)*50);
    if (val > t.max) return Math.max(0, 100-((val-t.max)/100)*20);
    return 50+((val-t.min)/(t.max-t.min))*50;
  } else {
    if (val < t.min) return Math.max(0, (val/t.min)*55);
    if (val > t.max) return Math.max(0, 100-((val-t.max)/(t.max*0.5))*55);
    const dist = Math.abs(val-t.ideal);
    const range = Math.max(t.ideal-t.min, t.max-t.ideal);
    return 55+(1-dist/range)*45;
  }
}

function calcDay(raw) {
  if (!raw) return null;
  const scores = {};
  let total=0, count=0;
  Object.keys(TARGETS).forEach(k => {
    const s = scoreMetric(k, raw[k]);
    scores[k] = s;
    if (s != null) { total+=s; count++; }
  });
  const composite = count ? Math.round(total/count) : null;
  const status = composite==null ? "unknown"
    : composite>=55 && composite<=75 ? "perfect"
    : composite>75 ? "high" : "low";
  return { composite, status, scores, raw };
}

// Colors per status
const C = {
  perfect: { text:"#b07af5", bg:"rgba(168,85,247,0.12)", border:"rgba(168,85,247,0.4)" },
  high:    { text:"#f47070", bg:"rgba(239,68,68,0.11)",  border:"rgba(239,68,68,0.4)" },
  low:     { text:"#60a5fa", bg:"rgba(59,130,246,0.11)", border:"rgba(59,130,246,0.4)" },
  unknown: { text:"#9ca3af", bg:"transparent", border:"transparent" },
};

function metricZone(key, val) {
  if (val==null) return "unknown";
  const t = TARGETS[key];
  if (val < t.min) return "low";
  if (val > t.max) return "high";
  return "perfect";
}

function explainMetric(key, val, prevVal) {
  if (val==null) return "No data available for this layer.";
  const t = TARGETS[key];
  const diff = prevVal!=null ? val-prevVal : null;
  const changeStr = diff==null ? "" : ` (${diff>=0?"+":""}${diff.toFixed(1)} ${t.unit} vs prev day)`;
  const v = val.toFixed(key==="geo300"?0:1);
  const zone = metricZone(key, val);

  const copy = {
    wind200: {
      low:     `At ${v} km/h, the upper jet stream was too weak. Below 130 km/h means there's no productive flow driving weather systems eastward — air masses stall over Toronto instead of clearing out.`,
      perfect: `At ${v} km/h, the upper jet stream was in the ideal range. This speed keeps systems moving progressively without over-amplifying the wave pattern into a deep cold trough.`,
      high:    `At ${v} km/h, the upper jet was over-energized. Above 210 km/h typically signals the Rossby wave pattern has amplified aggressively, which tends to buckle southward into a cold trough over the Great Lakes.`,
    },
    wind300: {
      low:     `At ${v} km/h, the steering-level jet was sluggish. Below 130 km/h means weather systems have no strong current to push them east — they park over Toronto.`,
      perfect: `At ${v} km/h, the 300 hPa steering jet was healthy. This is the level that drives the speed and trajectory of surface weather systems passing through our region.`,
      high:    `At ${v} km/h, the 300 hPa jet was running aggressively. Values above 185 km/h here often accompany a deep trough with cold air digging southward.`,
    },
    geo300: {
      low:     `The geopotential height was ${v} m — well below the normal May range of 9350–9450 m. A compressed atmosphere like this means a cold trough was overhead, dragging Arctic air southward into Toronto.`,
      perfect: `The geopotential height was ${v} m — within the normal May range of 9350–9450 m. This means the air column overhead was neither dominated by a cold trough nor an extreme ridge. Neutral territory.`,
      high:    `The geopotential height was ${v} m — above the normal May range. A tall air column like this means a warm ridge was building. Can be great for warmth, but if the jet is absent it creates stagnation.`,
    },
    wind500: {
      low:     `Mid-level flow was only ${v} km/h. Below 55 km/h means the middle of the atmosphere is nearly calm — weather systems have no steering current at this level and tend to drift or stall.`,
      perfect: `Mid-level flow was ${v} km/h — in the ideal range. The 500 hPa level acts as a secondary steering current; this reading suggests progressive, organized flow.`,
      high:    `Mid-level winds were ${v} km/h. Strong mid-level flow can keep systems moving, but this also signals an energetic, potentially amplified pattern.`,
    },
    pressure: {
      low:     `Sea-level pressure was ${v} hPa — below 1008 hPa. This means an active low pressure system or cyclone was situated over or near Toronto, associated with cloud, wind, and precipitation.`,
      perfect: `Sea-level pressure was ${v} hPa — in a healthy range. Values between 1008–1030 hPa at the surface support settled or progressively clearing weather conditions.`,
      high:    `Sea-level pressure was ${v} hPa — notably high. Strong surface high pressure brings clear and stable conditions, but can also trap cold air in place or slow system movement.`,
    },
  };
  return (copy[key]?.[zone] ?? `${v} ${t.unit}`) + (changeStr ? " " + changeStr : "");
}

function buildNarrative(info) {
  const { composite, status, raw, scores } = info;
  if (composite==null) return "Not enough data to score this day.";

  const allKeys = Object.keys(TARGETS);
  const outOfRange = allKeys.filter(k => {
    const z = metricZone(k, raw?.[k]);
    return z !== "perfect" && z !== "unknown";
  });

  if (status === "perfect") {
    return `The God Dial was dialled in today. All four atmospheric layers were reading close to their ideal values — the jet stream was driving progressive west-to-east flow at the right speed, the atmosphere wasn't buckled into a cold trough, and surface pressure supported settled conditions. This is exactly where the hypothetical dial should sit.`;
  }
  if (status === "high") {
    const offenders = outOfRange.filter(k => metricZone(k, raw?.[k])==="high").map(k => TARGETS[k].label);
    return `The dial was running too high — the atmosphere was over-energized today. ${offenders.length ? `The main offenders: ${offenders.join(", ")}. ` : ""}This typically means a Rossby wave had amplified too aggressively, pulling a cold trough southward over the Great Lakes. Too much energy in the system = deep waves = cold air for Toronto.`;
  }
  const offenders = outOfRange.filter(k => metricZone(k, raw?.[k])==="low").map(k => TARGETS[k].label);
  return `The dial was too low — the atmosphere was sluggish and collapsed today. ${offenders.length ? `The weak metrics: ${offenders.join(", ")}. ` : ""}This usually means a stagnant pattern where weather systems sit over Toronto instead of moving through. No jet speed = no steering current = stuck cold or damp conditions.`;
}

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
    } catch(e) { setError(e.message); }
    finally { setLoading(false); }
  }, [cache]);

  useEffect(() => { loadMonth(year, month); }, [year, month]);

  const today = new Date(); today.setHours(0,0,0,0);
  const allDates = Object.keys(dayData).sort();

  function goPrev() {
    setSelected(null);
    if (month===0) { setYear(y=>y-1); setMonth(11); } else setMonth(m=>m-1);
  }
  function goNext() {
    const nm=month===11?0:month+1, ny=month===11?year+1:year;
    if (new Date(ny,nm,1)>today) return;
    setSelected(null); setYear(ny); setMonth(nm);
  }

  function getInfo(dateStr) {
    const raw = dayData[dateStr];
    if (!raw) return null;
    const idx = allDates.indexOf(dateStr);
    const prevRaw = idx>0 ? dayData[allDates[idx-1]] : null;
    const cur  = calcDay(raw);
    const prev = calcDay(prevRaw);
    const delta = (cur?.composite!=null && prev?.composite!=null) ? cur.composite-prev.composite : null;
    return { ...cur, delta, prevRaw };
  }

  const selInfo = selected ? getInfo(selected) : null;
  const firstDay = new Date(year, month, 1).getDay();
  const daysInMo = new Date(year, month+1, 0).getDate();
  const dotColor = loading?"#fbbf24":error?"#ef4444":"#22c55e";

  return (
    <div style={{background:"#0d0f14",minHeight:"100vh",color:"#e4e8f0",fontFamily:"'Segoe UI',system-ui,sans-serif",padding:"20px 16px"}}>
      <style>{`
        @keyframes spin{to{transform:rotate(360deg)}}
        *{box-sizing:border-box;margin:0;padding:0}
        button:hover{border-color:#a855f7!important}
        .src-scroll::-webkit-scrollbar{width:3px}
        .src-scroll::-webkit-scrollbar-thumb{background:#2a2d3a;border-radius:2px}
        .day-cell:hover{filter:brightness(1.15)}
      `}</style>

      {/* HEADER */}
      <div style={{textAlign:"center",marginBottom:12}}>
        <h1 style={{fontSize:"clamp(1.3rem,3.5vw,1.8rem)",fontWeight:900,letterSpacing:"-0.03em",background:"linear-gradient(135deg,#fff 30%,#a855f7)",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent",backgroundClip:"text",margin:0}}>
          Toronto God Dial
        </h1>
        <p style={{color:"#6b7280",fontSize:"0.75rem",marginTop:3,fontFamily:"monospace"}}>
          Jet Stream Analysis — Dial Status?
        </p>
      </div>

      {/* STATUS */}
      <div style={{display:"flex",alignItems:"center",justifyContent:"center",gap:6,marginBottom:10,fontFamily:"monospace",fontSize:"0.68rem",color:"#6b7280"}}>
        <div style={{width:6,height:6,borderRadius:"50%",background:dotColor,boxShadow:`0 0 4px ${dotColor}`,flexShrink:0}}/>
        <span>{loading?"Fetching…":error?`Error: ${error.slice(0,80)}`:"Live · Open-Meteo · Toronto 43.7°N 79.4°W"}</span>
      </div>

      {/* TWO-COLUMN MAIN LAYOUT */}
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,minHeight:"calc(100vh - 220px)"}}>

        {/* LEFT COLUMN */}
        <div style={{display:"flex",flexDirection:"column",gap:8}}>

          {/* Color Legend */}
          <div style={{background:"#13161e",border:"1px solid #1e2230",borderRadius:10,padding:"9px 12px",flexShrink:0}}>
            <div style={{fontSize:"0.55rem",fontFamily:"monospace",color:"#6b7280",textTransform:"uppercase",letterSpacing:"0.1em",marginBottom:7}}>Color Guide</div>
            {[
              {dot:"#ef4444",text:"#f47070",label:"Red — Too High",    desc:"Over-amplified. Cold trough digging south."},
              {dot:"#3b82f6",text:"#60a5fa",label:"Blue — Too Low",    desc:"Collapsed. Systems stalling. No steering."},
              {dot:"#a855f7",text:"#b07af5",label:"Purple — Target",   desc:"Optimal. 130–185 km/h jet. Geo ≥9350 m."},
            ].map(({dot,text,label,desc}) => (
              <div key={label} style={{display:"flex",gap:7,marginBottom:6,alignItems:"flex-start"}}>
                <div style={{width:7,height:7,borderRadius:2,background:dot,flexShrink:0,marginTop:3}}/>
                <div>
                  <div style={{fontSize:"0.7rem",fontWeight:700,color:text,lineHeight:1.15,marginBottom:1}}>{label}</div>
                  <div style={{fontSize:"0.62rem",color:"#6b7280",lineHeight:1.3}}>{desc}</div>
                </div>
              </div>
            ))}
          </div>

          {/* Calendar */}
          <div style={{flex:1,display:"flex",flexDirection:"column",gap:6}}>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:4}}>
              <button onClick={goPrev} style={{background:"#13161e",border:"1px solid #1e2230",color:"#e4e8f0",padding:"5px 10px",borderRadius:5,cursor:"pointer",fontFamily:"monospace",fontSize:"0.68rem"}}>← Prev</button>
              <span style={{fontSize:"0.95rem",fontWeight:700}}>{MONTH_NAMES[month]} {year}</span>
              <button onClick={goNext} style={{background:"#13161e",border:"1px solid #1e2230",color:"#e4e8f0",padding:"5px 10px",borderRadius:5,cursor:"pointer",fontFamily:"monospace",fontSize:"0.68rem"}}>Next →</button>
            </div>
            <div style={{background:"#13161e",border:"1px solid #1e2230",borderRadius:10,overflow:"hidden",flex:1,display:"flex",flexDirection:"column"}}>
              <div style={{display:"grid",gridTemplateColumns:"repeat(7,1fr)",background:"rgba(255,255,255,0.03)",borderBottom:"1px solid #1e2230",flexShrink:0}}>
                {DAY_NAMES.map(d => (
                  <div key={d} style={{padding:"5px 0",textAlign:"center",fontSize:"0.55rem",fontFamily:"monospace",color:"#6b7280",textTransform:"uppercase",letterSpacing:"0.03em"}}>{d}</div>
                ))}
              </div>
              <div style={{display:"grid",gridTemplateColumns:"repeat(7,1fr)",flex:1}}>
                {Array.from({length:firstDay}).map((_,i) => (
                  <div key={`e${i}`} style={{minHeight:"auto",borderRight:"1px solid #1e2230",borderBottom:"1px solid #1e2230",background:"rgba(0,0,0,0.1)"}}/>
                ))}
                {Array.from({length:daysInMo}).map((_,i) => {
                  const day = i+1;
                  const pad = n => String(n).padStart(2,"0");
                  const dateStr = `${year}-${pad(month+1)}-${pad(day)}`;
                  const isFuture = new Date(year, month, day) > today;
                  const info = !isFuture ? getInfo(dateStr) : null;
                  const isSel = selected===dateStr;
                  const st = info?.status ?? "unknown";
                  const col = C[st];
                  const delta = info?.delta ?? null;

                  let arrow = null;
                  if (info) {
                    if (delta==null)        arrow = <span style={{fontSize:"0.65rem",color:"#4b5563",lineHeight:1}}>–</span>;
                    else if (Math.abs(delta)<=1) arrow = <span style={{fontSize:"0.68rem",color:"#6b7280",lineHeight:1}}>→</span>;
                    else if (delta>0)       arrow = <span style={{fontSize:"0.85rem",color:col.text,lineHeight:1,fontWeight:700}}>↑</span>;
                    else                    arrow = <span style={{fontSize:"0.85rem",color:col.text,lineHeight:1,fontWeight:700}}>↓</span>;
                  }

                  return (
                    <div
                      key={dateStr}
                      className="day-cell"
                      onClick={() => { if (!isFuture && info) setSelected(dateStr===selected?null:dateStr); }}
                      style={{
                        padding:"4px 2px",
                        borderRight:"1px solid #1e2230", borderBottom:"1px solid #1e2230",
                        cursor:isFuture||!info?"default":"pointer",
                        display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"flex-start", gap:0.5,
                        opacity:isFuture?0.3:1,
                        background:info?col.bg:"transparent",
                        outline:isSel?`2px solid ${col.border}`:"none",
                        outlineOffset:-2,
                        transition:"background 0.12s",
                        minHeight:"auto",
                      }}
                    >
                      <div style={{fontSize:"0.66rem",fontWeight:700,fontFamily:"monospace",color:info?col.text:"#9ca3af"}}>{day}</div>
                      {loading&&!info&&<div style={{width:6,height:6,border:"1px solid #1e2230",borderTopColor:"#a855f7",borderRadius:"50%",animation:"spin 0.8s linear infinite"}}/>}
                      {arrow}
                      {info?.composite!=null && <div style={{fontSize:"0.48rem",fontFamily:"monospace",color:col.text,textAlign:"center"}}>{info.composite}</div>}
                      {!info&&!loading&&!isFuture&&<div style={{fontSize:"0.44rem",color:"#4b5563",fontFamily:"monospace"}}>—</div>}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>

        {/* RIGHT COLUMN */}
        <div style={{display:"flex",flexDirection:"column",gap:8}}>

          {/* Data Sources */}
          <div style={{background:"#13161e",border:"1px solid #1e2230",borderRadius:10,padding:"9px 12px",display:"flex",flexDirection:"column",flexShrink:0}}>
            <div style={{fontSize:"0.55rem",fontFamily:"monospace",color:"#6b7280",textTransform:"uppercase",letterSpacing:"0.1em",marginBottom:6,flexShrink:0}}>
              Data Sources
            </div>
            <div className="src-scroll" style={{overflowY:"auto",flex:1,maxHeight:80,paddingRight:2}}>
              {[...Object.entries(TARGETS),
                ["score", {label:"Composite Score",unit:"0–100",desc:"Formula: (Score₃₀₀ + Score₅₀₀ + ScoreGeo + ScorePres) ÷ 4. Each metric scored 0–100 by distance from ideal. Purple: 55–75. Blue: <55. Red: >75",min:"55–75",ideal:"purple",max:">75 red / <55 blue"}]
              ].map(([k,t]) => (
                <div key={k} style={{display:"flex",gap:6,marginBottom:5,alignItems:"flex-start"}}>
                  <div style={{width:2,background:"#a855f7",borderRadius:1,alignSelf:"stretch",flexShrink:0}}/>
                  <div>
                    <span style={{fontSize:"0.65rem",fontWeight:700,color:"#d1d5db"}}>{t.label}</span>
                    {t.unit && <span style={{fontSize:"0.6rem",color:"#6b7280",marginLeft:4}}>({t.unit})</span>}
                    <div style={{fontSize:"0.58rem",color:"#6b7280",marginTop:1,lineHeight:1.3}}>{t.desc}</div>
                    {t.min && t.ideal && k!=="score" && (
                      <div style={{fontSize:"0.55rem",color:"#4b5563",fontFamily:"monospace"}}>Target {t.min}–{t.max}</div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Daily Detail / Summary Panel */}
          {selected && selInfo ? (() => {
            const d = new Date(selected+"T12:00:00");
            const label = d.toLocaleDateString("en-CA",{weekday:"short",month:"short",day:"numeric"});
            const st = selInfo.status;
            const col = C[st];
            const deltaStr = selInfo.delta==null ? "first" : selInfo.delta===0 ? "→" : `${selInfo.delta>0?"+":""}${selInfo.delta}`;
            const badgeText = st==="perfect"?"🟣 Target":st==="high"?"⬆ High":"⬇ Low";

            return (
              <div style={{background:"#13161e",border:`1px solid ${col.border}`,borderRadius:10,padding:"9px 12px",flex:1,display:"flex",flexDirection:"column",overflowY:"auto"}}>
                <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",gap:4,marginBottom:8,flexShrink:0}}>
                  <div>
                    <div style={{fontSize:"0.82rem",fontWeight:800,lineHeight:1}}>{label}</div>
                    <div style={{fontSize:"0.6rem",color:"#6b7280",marginTop:1}}>Click day to switch</div>
                  </div>
                  <div style={{display:"flex",flexDirection:"column",alignItems:"flex-end",gap:2,flexShrink:0}}>
                    <span style={{background:col.bg,color:col.text,border:`1px solid ${col.border}`,padding:"2px 8px",borderRadius:14,fontSize:"0.65rem",fontWeight:700,whiteSpace:"nowrap"}}>{badgeText}</span>
                    <span style={{fontFamily:"monospace",fontSize:"1.1rem",fontWeight:900,color:col.text,lineHeight:1}}>
                      {selInfo.composite??"-"}<span style={{fontSize:"0.65rem",fontWeight:400}}>/100</span>
                    </span>
                    <span style={{fontSize:"0.55rem",color:"#6b7280",fontFamily:"monospace"}}>{deltaStr} vs prev</span>
                  </div>
                </div>

                <div style={{background:col.bg,borderLeft:`2px solid ${col.border}`,padding:"6px 8px",borderRadius:"0 5px 5px 0",marginBottom:8,fontSize:"0.7rem",lineHeight:1.5,color:"#d1d5db",flexShrink:0}}>
                  {buildNarrative(selInfo)}
                </div>

                <div style={{fontSize:"0.5rem",fontFamily:"monospace",color:"#6b7280",textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:5,flexShrink:0}}>
                  Metrics
                </div>
                <div style={{display:"flex",flexDirection:"column",gap:4,overflowY:"auto",flex:1}}>
                  {Object.entries(TARGETS).map(([k,t]) => {
                    const val = selInfo.raw?.[k];
                    const score = selInfo.scores?.[k];
                    const zone = metricZone(k, val);
                    const mc = C[zone==="ok"||zone==="perfect"?"perfect":zone];
                    const pct = score!=null ? Math.min(100,Math.max(0,Math.round(score))) : 0;

                    return (
                      <div key={k} style={{background:"rgba(255,255,255,0.015)",borderRadius:5,padding:"6px 8px",border:"1px solid #1e2230",flexShrink:0}}>
                        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:3,gap:3}}>
                          <span style={{fontWeight:700,fontSize:"0.65rem",color:"#e4e8f0"}}>{t.label}</span>
                          <span style={{fontFamily:"monospace",fontWeight:900,fontSize:"0.78rem",color:mc.text}}>
                            {val!=null?val.toFixed(k==="geo300"?0:1):"—"} {t.unit}
                          </span>
                        </div>
                        <div style={{height:2,background:"#1e2230",borderRadius:1,marginBottom:3,overflow:"hidden"}}>
                          <div style={{height:"100%",width:`${pct}%`,background:mc.text,borderRadius:1}}/>
                        </div>
                        <div style={{fontSize:"0.58rem",color:"#9ca3af",lineHeight:1.4,marginBottom:2}}>
                          {explainMetric(k, val, selInfo.prevRaw?.[k]).slice(0,100)}...
                        </div>
                        <div style={{fontSize:"0.54rem",color:"#4b5563",fontFamily:"monospace"}}>
                          {t.min}–{t.max}{zone==="low"?" ↙":zone==="high"?" ↗":" ✓"}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })() : (
            <div style={{background:"#13161e",border:"1px solid #1e2230",borderRadius:10,padding:12,flex:1,display:"flex",alignItems:"center",justifyContent:"center",color:"#6b7280",fontSize:"0.73rem",textAlign:"center",fontFamily:"monospace"}}>
              Click a day to see breakdown
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
