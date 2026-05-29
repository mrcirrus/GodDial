import { useState, useEffect, useCallback } from "react";

const LAT = 43.7, LON = -79.42;

const TARGETS = {
  wind200:  { min: 130, ideal: 160, max: 210, label: "200 hPa Jet",      unit: "km/h", key: "wind_speed_200hPa" },
  wind300:  { min: 130, ideal: 145, max: 185, label: "300 hPa Jet",      unit: "km/h", key: "wind_speed_300hPa" },
  geo300:   { min: 9200, ideal: 9390, max: 9500, label: "300 hPa GeoH",  unit: "m",    key: "geopotential_height_300hPa" },
  wind500:  { min: 55,  ideal: 95,  max: 140,  label: "500 hPa Wind",    unit: "km/h", key: "wind_speed_500hPa" },
  pressure: { min: 1008, ideal: 1016, max: 1025, label: "Sea Level P",   unit: "hPa",  key: "surface_pressure" },
};

const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const DAYS   = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];

async function fetchMonthData(year, month) {
  const pad = n => String(n).padStart(2,"0");
  const start = `${year}-${pad(month+1)}-01`;
  const lastDay = new Date(year, month+1, 0).getDate();
  const end = `${year}-${pad(month+1)}-${pad(lastDay)}`;
  const vars = Object.values(TARGETS).map(t=>t.key).join(",");
  const url = `https://historical-forecast-api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LON}&start_date=${start}&end_date=${end}&hourly=${vars}&wind_speed_unit=kmh&timezone=America%2FToronto`;
  const res = await fetch(url);
  if (!res.ok) { const t = await res.text(); throw new Error(`API ${res.status}: ${t.slice(0,120)}`); }
  return parseHourly(await res.json());
}

function parseHourly(json) {
  const h = json.hourly;
  const byDate = {};
  h.time.forEach((t,i) => {
    const date = t.split("T")[0];
    if (!byDate[date]) byDate[date] = {wind200:[],wind300:[],geo300:[],wind500:[],pressure:[]};
    const d = byDate[date];
    const push = (a,v) => { if (v!=null && !isNaN(v)) a.push(v); };
    push(d.wind200, h.wind_speed_200hPa?.[i]);
    push(d.wind300, h.wind_speed_300hPa?.[i]);
    push(d.geo300,  h.geopotential_height_300hPa?.[i]);
    push(d.wind500, h.wind_speed_500hPa?.[i]);
    push(d.pressure,h.surface_pressure?.[i]);
  });
  const result = {};
  Object.entries(byDate).forEach(([date,arrs]) => {
    const avg = a => a.length ? a.reduce((x,y)=>x+y,0)/a.length : null;
    const max = a => a.length ? Math.max(...a) : null;
    result[date] = { wind200:max(arrs.wind200), wind300:max(arrs.wind300), geo300:avg(arrs.geo300), wind500:max(arrs.wind500), pressure:avg(arrs.pressure) };
  });
  return result;
}

function scoreMetric(key, val) {
  if (val==null) return null;
  const t = TARGETS[key];
  if (key==="geo300"||key==="pressure") {
    if (val<t.min) return Math.max(0,((val-(t.min-300))/300)*50);
    if (val>t.max) return Math.max(0,100-((val-t.max)/100)*20);
    return 50+((val-t.min)/(t.max-t.min))*50;
  } else {
    if (val<t.min) return Math.max(0,(val/t.min)*55);
    if (val>t.max) return Math.max(0,100-((val-t.max)/(t.max*0.5))*55);
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
    scores[k]=s;
    if (s!=null){total+=s;count++;}
  });
  const composite = count ? Math.round(total/count) : null;
  const status = composite==null ? "unknown"
    : composite>=55&&composite<=75 ? "perfect"
    : composite>75 ? "high" : "low";
  return {composite, status, scores, raw};
}

function buildSummary(status, raw, composite) {
  const w2=raw?.wind200?.toFixed(0), w3=raw?.wind300?.toFixed(0);
  const g3=raw?.geo300?.toFixed(0), pr=raw?.pressure?.toFixed(1), w5=raw?.wind500?.toFixed(0);
  if (status==="perfect") return `Score ${composite}/100 — Pipe at working pressure. 300 hPa jet ${w3} km/h, 200 hPa ${w2} km/h, geopotential ${g3} m, surface ${pr} hPa. Systems steering east cleanly. God holds the dial here.`;
  if (status==="high") {
    const r=[];
    if (raw?.wind300>185) r.push(`300 hPa jet (${w3} km/h) kinked past 185 target`);
    if (raw?.wind200>210) r.push(`200 hPa jet (${w2} km/h) over-pressured above 210`);
    if (raw?.geo300<9200) r.push(`geopotential (${g3} m) deep cold trough — flow pinched`);
    if (raw?.pressure<1008) r.push(`active cyclone (${pr} hPa) compressing column`);
    if (raw?.pressure>1025) r.push(`arctic high (${pr} hPa) clamping jet from north`);
    if (!r.length) r.push(`composite ${composite}/100 over-pressured across metrics`);
    return `Score ${composite}/100 — Pipe PINCHED/TOO HIGH. ${r.join("; ")}. Chaotic stagnation — systems spin instead of tracking east. God would ease pressure and flatten the wave.`;
  }
  const r=[];
  if (raw?.wind300<130) r.push(`300 hPa jet (${w3} km/h) collapsed below 130 steering threshold`);
  if (raw?.wind200<130) r.push(`200 hPa jet (${w2} km/h) below 130 minimum`);
  if (raw?.wind500<55)  r.push(`500 hPa winds (${w5} km/h) too weak to steer systems`);
  if (raw?.geo300>9500) r.push(`geopotential (${g3} m) stagnant ridge, no jet drive`);
  if (!r.length) r.push(`composite ${composite}/100 lacks driving pressure`);
  return `Score ${composite}/100 — Pipe TOO LOW/NO PRESSURE. ${r.join("; ")}. Systems drift and stall, cold air lingers. God would turn dial up to 140–160 km/h.`;
}

const C = {
  high: "#ef4444", low: "#3b82f6", perfect: "#a855f7",
  bg: "#0d0f14", panel: "#13161e", border: "#1e2230",
  text: "#e4e8f0", muted: "#6b7280",
};

function statusColor(s) {
  return s==="perfect"?C.perfect:s==="high"?C.high:s==="low"?C.low:C.muted;
}

export default function App() {
  const now = new Date();
  const [year, setYear]       = useState(now.getFullYear());
  const [month, setMonth]     = useState(now.getMonth());
  const [cache, setCache]     = useState({});
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState(null);
  const [selected, setSelected] = useState(null);
  const [modalDay, setModalDay] = useState(null);

  const cacheKey = `${year}-${month}`;
  const dayData  = cache[cacheKey]||{};

  const loadMonth = useCallback(async (y,m) => {
    const key=`${y}-${m}`;
    if (cache[key]) return;
    setLoading(true); setError(null);
    try { const data=await fetchMonthData(y,m); setCache(prev=>({...prev,[key]:data})); }
    catch(e){ setError(e.message); }
    finally { setLoading(false); }
  },[cache]);

  useEffect(()=>{ loadMonth(year,month); },[year,month]);

  const today = new Date(); today.setHours(0,0,0,0);
  const isCurrentMonth = year===today.getFullYear()&&month===today.getMonth();
  const allDates = Object.keys(dayData).sort();

  function goPrev() {
    setSelected(null);
    if (month===0){setYear(y=>y-1);setMonth(11);}else setMonth(m=>m-1);
  }
  function goNext() {
    if (isCurrentMonth) return;
    const nm=month===11?0:month+1, ny=month===11?year+1:year;
    if (new Date(ny,nm,1)>today) return;
    setSelected(null); setYear(ny); setMonth(nm);
  }

  function getInfo(dateStr) {
    const raw = dayData[dateStr];
    if (!raw) return null;
    const idx = allDates.indexOf(dateStr);
    const prevRaw = idx>0 ? dayData[allDates[idx-1]] : null;
    const cur  = calcDay(raw);
    const prev = calcDay(prevRaw);
    const delta = cur?.composite!=null&&prev?.composite!=null ? cur.composite-prev.composite : null;
    return {...cur, calStatus:cur?.status, delta, prevRaw};
  }

  function metricColor(key,val) {
    if (val==null) return C.muted;
    const t=TARGETS[key];
    return val<t.min?C.low:val>t.max?C.high:C.perfect;
  }
  function barPct(key,val) {
    if (val==null) return 0;
    const t=TARGETS[key];
    const lo=key==="geo300"?t.min-300:key==="pressure"?990:0;
    const hi=key==="geo300"?t.max+100:key==="pressure"?t.max+15:t.max*1.4;
    return ((val-lo)/(hi-lo))*100;
  }

  const firstDay = new Date(year,month,1).getDay();
  const daysInMo = new Date(year,month+1,0).getDate();
  const dotColor = loading?"#fbbf24":error?"#ef4444":"#22c55e";

  // Close modal on backdrop click
  function handleBackdrop(e) {
    if (e.target===e.currentTarget) setModalDay(null);
  }

  const modalInfo = modalDay ? getInfo(modalDay) : null;

  return (
    <div style={{background:C.bg,minHeight:"100vh",color:C.text,fontFamily:"'Segoe UI',system-ui,sans-serif",padding:"10px 12px",boxSizing:"border-box"}}>
      <style>{`
        @keyframes spin{to{transform:rotate(360deg)}}
        *{box-sizing:border-box;margin:0;padding:0}
        body{background:${C.bg};overflow-x:hidden}
        ::-webkit-scrollbar{width:4px;height:4px}
        ::-webkit-scrollbar-track{background:${C.bg}}
        ::-webkit-scrollbar-thumb{background:#2d3148;border-radius:2px}
      `}</style>

      {/* HEADER — compact */}
      <div style={{textAlign:"center",marginBottom:8}}>
        <h1 style={{fontSize:"clamp(1.3rem,3vw,1.9rem)",fontWeight:900,letterSpacing:"-0.03em",background:"linear-gradient(135deg,#fff 30%,#a855f7)",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent",backgroundClip:"text"}}>
          Toronto God Dial
        </h1>
        <div style={{display:"flex",alignItems:"center",justifyContent:"center",gap:6,marginTop:4,fontFamily:"monospace",fontSize:"0.7rem",color:C.muted}}>
          <div style={{width:7,height:7,borderRadius:"50%",background:dotColor,boxShadow:`0 0 5px ${dotColor}`}}/>
          <span>{loading?"Fetching Open-Meteo data…":error?`Error: ${error.slice(0,60)}`:("Live · ERA5+GFS · Toronto 43.7°N 79.4°W")}</span>
        </div>
      </div>

      {/* INFO ROW — legend left, metrics right, side by side */}
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:8}}>

        {/* LEFT: God Dial Reading Guide */}
        <div style={{background:C.panel,border:`1px solid ${C.border}`,borderRadius:8,padding:"10px 12px"}}>
          <div style={{fontSize:"0.6rem",fontFamily:"monospace",color:C.muted,textTransform:"uppercase",letterSpacing:"0.1em",marginBottom:7}}>God Dial Reading Guide</div>
          <div style={{display:"flex",flexDirection:"column",gap:6}}>
            {[
              {c:C.high, e:"🔴", t:"TOO HIGH — Pipe Pinched", d:"Jet kinked >185 km/h or arctic high clamping from north. Chaotic stagnation."},
              {c:C.low,  e:"🔵", t:"TOO LOW — No Pressure",   d:"Jet collapsed <130 km/h. No drive. Systems drift. Cold air stagnates."},
              {c:C.perfect,e:"🟣",t:"OPTIMAL — Working Pressure",d:"Jet 130–185 km/h, flat flow, geo ≥9350 m, SLP 1008–1025 hPa."},
            ].map(({c,e,t,d})=>(
              <div key={t} style={{display:"flex",gap:7,alignItems:"flex-start"}}>
                <div style={{width:8,height:8,borderRadius:2,background:c,flexShrink:0,marginTop:3}}/>
                <div>
                  <div style={{fontWeight:700,fontSize:"0.72rem",marginBottom:1}}>{e} {t}</div>
                  <div style={{color:C.muted,fontSize:"0.64rem",lineHeight:1.35}}>{d}</div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* RIGHT: Data Sources */}
        <div style={{background:C.panel,border:`1px solid ${C.border}`,borderRadius:8,padding:"10px 12px"}}>
          <div style={{fontSize:"0.6rem",fontFamily:"monospace",color:C.muted,textTransform:"uppercase",letterSpacing:"0.1em",marginBottom:7}}>Data Sources — Open-Meteo · ERA5+GFS · Free · No Key</div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"5px 8px"}}>
            {Object.entries(TARGETS).map(([k,t])=>(
              <div key={k} style={{background:"rgba(168,85,247,0.07)",borderRadius:5,padding:"5px 8px",borderLeft:`2px solid ${C.perfect}`}}>
                <div style={{fontWeight:700,fontSize:"0.68rem"}}>{t.label} <span style={{color:C.muted,fontWeight:400}}>({t.unit})</span></div>
                <div style={{color:C.muted,fontFamily:"monospace",fontSize:"0.61rem"}}>{t.min}–{t.max} · ideal {t.ideal}</div>
              </div>
            ))}
            <div style={{background:"rgba(168,85,247,0.07)",borderRadius:5,padding:"5px 8px",borderLeft:`2px solid ${C.perfect}`}}>
              <div style={{fontWeight:700,fontSize:"0.68rem"}}>Composite Score</div>
              <div style={{color:C.muted,fontFamily:"monospace",fontSize:"0.61rem"}}>55–75=🟣 &lt;55=🔵 &gt;75=🔴</div>
            </div>
          </div>
        </div>
      </div>

      {/* CALENDAR NAV */}
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:6}}>
        <button onClick={goPrev} style={{background:C.panel,border:`1px solid ${C.border}`,color:C.text,padding:"5px 14px",borderRadius:6,cursor:"pointer",fontFamily:"monospace",fontSize:"0.75rem"}}>← Prev</button>
        <span style={{fontSize:"1rem",fontWeight:700,letterSpacing:"-0.01em"}}>{MONTHS[month]} {year}</span>
        <button onClick={goNext} disabled={isCurrentMonth} style={{background:C.panel,border:`1px solid ${C.border}`,color:isCurrentMonth?"#374151":C.text,padding:"5px 14px",borderRadius:6,cursor:isCurrentMonth?"not-allowed":"pointer",fontFamily:"monospace",fontSize:"0.75rem",opacity:isCurrentMonth?0.4:1}}>Next →</button>
      </div>

      {/* CALENDAR */}
      <div style={{background:C.panel,border:`1px solid ${C.border}`,borderRadius:8,overflow:"hidden"}}>
        {/* Day headers */}
        <div style={{display:"grid",gridTemplateColumns:"repeat(7,1fr)",background:"rgba(255,255,255,0.03)",borderBottom:`1px solid ${C.border}`}}>
          {DAYS.map(d=>(
            <div key={d} style={{padding:"6px 0",textAlign:"center",fontSize:"0.62rem",fontFamily:"monospace",color:C.muted,textTransform:"uppercase",letterSpacing:"0.05em"}}>{d}</div>
          ))}
        </div>
        {/* Day cells */}
        <div style={{display:"grid",gridTemplateColumns:"repeat(7,1fr)"}}>
          {Array.from({length:firstDay}).map((_,i)=>(
            <div key={`e${i}`} style={{borderRight:`1px solid ${C.border}`,borderBottom:`1px solid ${C.border}`,minHeight:68,background:"rgba(0,0,0,0.1)"}}/>
          ))}
          {Array.from({length:daysInMo}).map((_,i)=>{
            const day=i+1;
            const pad=n=>String(n).padStart(2,"0");
            const dateStr=`${year}-${pad(month+1)}-${pad(day)}`;
            const isFuture=new Date(year,month,day)>today;
            const info=(!isFuture&&!loading)?getInfo(dateStr):null;
            const isSel=selected===dateStr;
            const sc=info?.calStatus;
            const col=statusColor(sc);

            // Trend arrow based on delta
            const trendArrow = info?.delta==null ? null
              : info.delta>2  ? "⬆️"
              : info.delta<-2 ? "⬇️"
              : "➡️";

            return (
              <div
                key={dateStr}
                onClick={()=>{ if(!isFuture&&info){ setSelected(dateStr===selected?null:dateStr); setModalDay(dateStr===modalDay?null:dateStr); }}}
                style={{
                  minHeight:68, padding:"5px 4px",
                  borderRight:`1px solid ${C.border}`,borderBottom:`1px solid ${C.border}`,
                  cursor:isFuture||!info?"default":"pointer",
                  display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"flex-start",gap:2,
                  opacity:isFuture?0.2:1,
                  background:isFuture?"transparent":sc==="perfect"?"rgba(168,85,247,0.13)":sc==="high"?"rgba(239,68,68,0.11)":sc==="low"?"rgba(59,130,246,0.11)":"transparent",
                  outline:isSel?`2px solid ${C.perfect}`:"none",outlineOffset:-2,
                  transition:"background 0.15s",
                }}
              >
                <div style={{fontSize:"0.75rem",fontWeight:700,fontFamily:"monospace",color:col}}>{day}</div>
                {loading&&!info&&<div style={{width:10,height:10,border:`2px solid ${C.border}`,borderTopColor:C.perfect,borderRadius:"50%",animation:"spin 0.8s linear infinite"}}/>}
                {info&&<div style={{fontSize:"1rem",lineHeight:1}}>{sc==="perfect"?"🟣":sc==="high"?"🔴":"🔵"}</div>}
                {info?.composite!=null&&(
                  <div style={{fontSize:"0.55rem",fontFamily:"monospace",color:col,textAlign:"center"}}>{info.composite}/100</div>
                )}
                {trendArrow&&(
                  <div style={{fontSize:"0.6rem",lineHeight:1}}>{trendArrow}</div>
                )}
                {!info&&!loading&&!isFuture&&<div style={{fontSize:"0.52rem",color:"#4b5563",fontFamily:"monospace"}}>—</div>}
              </div>
            );
          })}
        </div>
      </div>

      {/* MODAL POPUP — detail panel */}
      {modalDay&&modalInfo&&(
        <div
          onClick={handleBackdrop}
          style={{
            position:"fixed",inset:0,background:"rgba(0,0,0,0.75)",
            display:"flex",alignItems:"center",justifyContent:"center",
            zIndex:1000,padding:16,backdropFilter:"blur(4px)",
          }}
        >
          <div style={{
            background:C.panel,border:`1px solid ${C.border}`,borderRadius:12,
            padding:20,width:"100%",maxWidth:700,maxHeight:"85vh",
            overflowY:"auto",position:"relative",
          }}>
            {/* Modal header */}
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:14,flexWrap:"wrap",gap:8}}>
              <div>
                <div style={{fontSize:"1rem",fontWeight:800,letterSpacing:"-0.02em"}}>
                  {new Date(modalDay+"T12:00:00").toLocaleDateString("en-CA",{weekday:"long",year:"numeric",month:"long",day:"numeric"})}
                </div>
              </div>
              <div style={{display:"flex",alignItems:"center",gap:8}}>
                <div style={{padding:"4px 12px",borderRadius:16,fontSize:"0.78rem",fontWeight:700,
                  background:modalInfo.calStatus==="perfect"?"rgba(168,85,247,0.15)":modalInfo.calStatus==="high"?"rgba(239,68,68,0.12)":"rgba(59,130,246,0.12)",
                  color:statusColor(modalInfo.calStatus),
                  border:`1px solid ${statusColor(modalInfo.calStatus)}44`,
                }}>
                  {modalInfo.calStatus==="perfect"?"🟣 Optimal":modalInfo.calStatus==="high"?"🔴 Too High — Pinched":"🔵 Too Low — No Pressure"}
                </div>
                <button onClick={()=>setModalDay(null)} style={{background:"rgba(255,255,255,0.07)",border:`1px solid ${C.border}`,color:C.text,width:30,height:30,borderRadius:6,cursor:"pointer",fontSize:"1rem",display:"flex",alignItems:"center",justifyContent:"center"}}>✕</button>
              </div>
            </div>

            {/* Trend + score row */}
            <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:12,padding:"7px 11px",background:"rgba(255,255,255,0.03)",borderRadius:7,fontFamily:"monospace",fontSize:"0.73rem",flexWrap:"wrap"}}>
              <span style={{color:C.muted}}>Trend:</span>
              <span style={{fontWeight:700,color:modalInfo.delta==null?C.muted:modalInfo.delta>2?C.high:modalInfo.delta<-2?C.low:"#9ca3af"}}>
                {modalInfo.delta==null?"No prior data":modalInfo.delta>2?`⬆️ +${modalInfo.delta} pts vs yesterday`:modalInfo.delta<-2?`⬇️ ${modalInfo.delta} pts vs yesterday`:`➡️ ${modalInfo.delta>0?"+":""}${modalInfo.delta} pts (holding)`}
              </span>
              <span style={{marginLeft:"auto",color:C.muted}}>Score: <strong style={{color:C.text}}>{modalInfo.composite}/100</strong></span>
            </div>

            {/* Metric cards */}
            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(180px,1fr))",gap:8,marginBottom:12}}>
              {Object.entries(TARGETS).map(([k,t])=>{
                const val=modalInfo.raw?.[k];
                const prevVal=modalInfo.prevRaw?.[k];
                const diff=val!=null&&prevVal!=null?val-prevVal:null;
                const diffStr=diff==null?"—":diff>=0?`+${diff.toFixed(1)}`:diff.toFixed(1);
                const diffArrow=diff==null?"→":diff>0.3?"↑":diff<-0.3?"↓":"→";
                const diffColor=diff==null?C.muted:diff>0.3?C.high:diff<-0.3?C.low:C.muted;
                const color=metricColor(k,val);
                const score=modalInfo.scores?.[k];
                return (
                  <div key={k} style={{background:"rgba(255,255,255,0.03)",border:`1px solid ${C.border}`,borderRadius:7,padding:11}}>
                    <div style={{fontSize:"0.6rem",fontFamily:"monospace",color:C.muted,textTransform:"uppercase",letterSpacing:"0.07em",marginBottom:5}}>{t.label}</div>
                    <div style={{fontSize:"1.2rem",fontWeight:900,fontFamily:"monospace",color,marginBottom:2}}>
                      {val!=null?val.toFixed(k==="geo300"?0:1):"N/A"}
                      <span style={{fontSize:"0.7rem",marginLeft:3}}>{t.unit}</span>
                    </div>
                    <div style={{fontSize:"0.67rem",fontFamily:"monospace",marginBottom:3}}>
                      <span style={{color:diffColor}}>{diffArrow} {diffStr} {t.unit}</span>
                    </div>
                    <div style={{fontSize:"0.6rem",color:C.muted,fontFamily:"monospace"}}>
                      {t.min}–{t.max} · ideal {t.ideal}
                      {score!=null&&<span style={{marginLeft:6,color}}>[{score.toFixed(0)}]</span>}
                    </div>
                    <div style={{height:3,background:C.border,borderRadius:2,marginTop:5,overflow:"hidden"}}>
                      <div style={{height:"100%",width:`${Math.min(100,Math.max(0,barPct(k,val)))}%`,background:color,borderRadius:2,transition:"width 0.5s"}}/>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Summary */}
            <div style={{background:"rgba(168,85,247,0.06)",borderRadius:7,padding:12,fontSize:"0.78rem",lineHeight:1.65,borderLeft:`3px solid ${C.perfect}`}}>
              {buildSummary(modalInfo.calStatus, modalInfo.raw, modalInfo.composite)}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}