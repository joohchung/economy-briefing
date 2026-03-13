import { useState, useEffect, useRef } from "react";

function getKST() {
  const kst = new Date(Date.now() + 9 * 3600 * 1000);
  const pad = n => String(n).padStart(2, "0");
  const days = ["월","화","수","목","금"];
  const h = kst.getUTCHours();
  return {
    date:    `${kst.getUTCFullYear()}년 ${kst.getUTCMonth()+1}월 ${kst.getUTCDate()}일`,
    weekday: days[kst.getUTCDay()],
    time:    `${pad(h)}:${pad(kst.getUTCMinutes())}`,
    full:    `${kst.getUTCFullYear()}년 ${kst.getUTCMonth()+1}월 ${kst.getUTCDate()}일 (${days[kst.getUTCDay()]}) ${pad(h)}:${pad(kst.getUTCMinutes())} KST`,
    isKrOpen: h >= 9 && h < 15,
    hour: h,
    minute: kst.getUTCMinutes(),
  };
}

async function claudeSearch(system, user, maxIter = 4) {
  const msgs = [{ role: "user", content: user }];
  for (let i = 0; i < maxIter; i++) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json",
     "x-api-key": import.meta.env.VITE_ANTHROPIC_KEY,
     "anthropic-version": "2023-06-01",
     "anthropic-dangerous-direct-browser-access": "true"
     },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 5000,
        system,
        tools: [{ type: "web_search_20250305", name: "web_search" }],
        messages: msgs,
      }),
    });
    if (res.status === 429) {
      const w = parseInt(res.headers.get("retry-after") || "10", 10);
      await new Promise(r => setTimeout(r, w * 1000));
      continue;
    }
    if (!res.ok) throw new Error(`API 오류 ${res.status}: ${await res.text()}`);
    const d = await res.json();
    msgs.push({ role: "assistant", content: d.content });
    if (d.stop_reason === "end_turn")
      return d.content.filter(b => b.type === "text").map(b => b.text).join("");
    if (d.stop_reason === "tool_use") {
      msgs.push({
        role: "user",
        content: d.content.filter(b => b.type === "tool_use").map(b => ({
          type: "tool_result", tool_use_id: b.id,
          content: b.content ? JSON.stringify(b.content) : "검색 완료",
        })),
      });
    }
  }
  throw new Error("최대 반복 초과");
}

function extractJSON(text) {
  const s = text.indexOf("{");
  if (s === -1) throw new Error("JSON 없음");
  let depth = 0, e = -1;
  for (let i = s; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") { if (--depth === 0) { e = i; break; } }
  }
  if (e === -1) throw new Error("JSON 불완전");
  try { return JSON.parse(text.slice(s, e + 1)); }
  catch { return JSON.parse(text.slice(s, e + 1).replace(/[\r\n\t]/g, " ")); }
}

function stripCite(s) {
  return typeof s === "string"
    ? s.replace(/<cite[^>]*>([\s\S]*?)<\/cite>/g, "$1").replace(/<\/?cite[^>]*>/g, "")
    : s;
}
function cleanObj(obj) {
  if (typeof obj === "string") return stripCite(obj);
  if (Array.isArray(obj)) return obj.map(cleanObj);
  if (obj && typeof obj === "object") {
    const r = {};
    for (const k of Object.keys(obj)) r[k] = cleanObj(obj[k]);
    return r;
  }
  return obj;
}

async function fetchBriefing(kst) {
  const h = kst.hour;
  const m = kst.minute;
  // 15:30 이후 장후
  const krClosed = h > 15 || (h === 15 && m >= 30);
  const krStatus = krClosed ? "장후" : (h >= 9 ? "장중" : "장전");

  const system = `당신은 실시간 경제 분석 전문가입니다.
반드시 웹검색으로 현재 시점의 실제 수치를 확인하세요.
학습된 기억 속 숫자는 절대 사용 금지.
JSON만 출력. 마크다운 없이 { 로 시작 } 로 끝.`;

  const krNote = krClosed
    ? `한국 증시 장후. 코스피/코스닥 금일 종가를 KRX(krx.co.kr) 또는 네이버금융에서 확인.`
    : `한국 증시 ${krStatus}. 코스피/코스닥 전일 종가를 네이버금융에서 확인.`;

  const todayStr = `${kst.date} (${kst.weekday})`;

  const user = `현재: ${kst.full}
${krNote}

[검색 - 2번]
1. "S&P500 nasdaq dow jones stock price today" → 야후파이낸스 미국 전일 종가 확인
2. "${todayStr} 오늘 경제뉴스 증시" + "코스피 코스닥 ${krClosed ? "오늘 종가 KRX" : "전일 종가"}" → 반드시 오늘 ${todayStr} 날짜 뉴스만 수집

⚠️ 규칙:
- 뉴스는 반드시 오늘 ${todayStr} 날짜 기사만. 어제 뉴스 절대 금지
- 미국: 야후파이낸스 전일 종가만 (선물 불필요)
- 한국: ${krClosed ? "KRX/네이버금융 금일 종가" : "네이버금융 전일 종가"} (선물/현재가 불필요)
- 지수 date 필드: "M/D" 형식으로 해당 날짜 기입
- 뉴스 최소 5건
- 발표된 지표 → "✅ 완료:[값]" / 미발표 → "🔮 예정:(날짜 KST)"

JSON만:
{
  "sp500":     {"close":"숫자","chg":"+0.00%","date":"M/D"},
  "nasdaq100": {"close":"숫자","chg":"+0.00%","date":"M/D"},
  "dow":       {"close":"숫자","chg":"+0.00%","date":"M/D"},
  "kospi":     {"close":"숫자","chg":"+0.00%","date":"M/D"},
  "kosdaq":    {"close":"숫자","chg":"+0.00%","date":"M/D"},
  "kr_status": "${krStatus}",
  "us_cause":  "전일 미국 시장 흐름 원인 2~3줄 (구체적 근거 포함)",
  "us_dir":    "오늘 개장 방향성 2줄",
  "us_sector": "주목 섹터/종목 2줄 (수치 포함)",
  "kr_cause":  "전일 한국 시장 흐름 원인 2~3줄 (구체적 근거 포함)",
  "kr_dir":    "오늘 국내 시장 방향성 2줄",
  "kr_sector": "주목 업종/테마 2줄 (구체적 이유 포함)",
  "summary":   "오늘 투자자가 가장 주목할 핵심 포인트 2문장",
  "news": [
    {"title":"제목","summary":"핵심 내용 2~3줄","impact":"시장 영향 1~2줄"}
  ],
  "sectors":   ["섹터1 — 이유 2줄","섹터2 — 이유 2줄","섹터3 — 이유 2줄","섹터4 — 이유 2줄"],
  "events":    ["✅ 완료:[값] 또는 🔮 예정:(날짜 KST) — 설명"],
  "short_term":"단기 관점 2~3줄 (수치/근거 포함)",
  "long_term": "장기 관점 2~3줄 (수치/근거 포함)",
  "risks":     ["리스크1 — 설명 2줄","리스크2 — 설명 2줄","리스크3 — 설명 2줄","리스크4 — 설명 2줄"]
}`;

  const raw = await claudeSearch(system, user);
  return cleanObj(extractJSON(raw));
}

// ── 등락률 태그 (한국식: 상승=빨강, 하락=파랑) ──
function Tag({ v }) {
  if (v == null || v === "") return <span style={{color:"#9ca3af",fontSize:"0.8rem"}}>-</span>;
  const n = parseFloat(String(v).replace(/[+%,]/g,""));
  const pos = n > 0, neg = n < 0;
  const s = String(v);
  const display = (pos && !s.startsWith("+") ? "+" : "") + (s.includes("%") ? s : s + "%");
  return (
    <span style={{
      display:"inline-block", padding:"2px 9px", borderRadius:999, fontSize:"0.8rem", fontWeight:700,
      background: pos?"#fee2e2": neg?"#dbeafe":"#f3f4f6",
      color:      pos?"#b91c1c": neg?"#1d4ed8":"#374151",
    }}>{display}</span>
  );
}

function Card({ icon, title, children, accent }) {
  return (
    <div style={{ marginBottom:18, background:"#fff", borderRadius:18, boxShadow:"0 2px 16px rgba(0,0,0,0.07)", overflow:"hidden" }}>
      <div style={{ display:"flex", alignItems:"center", gap:8, padding:"13px 18px 10px", borderBottom:"1.5px solid #f0f0f0", background:accent||"#fafbfc" }}>
        <span style={{ fontSize:"1.1rem" }}>{icon}</span>
        <span style={{ fontWeight:800, fontSize:"0.97rem", color:"#1a1a2e" }}>{title}</span>
      </div>
      <div style={{ padding:"15px 18px" }}>{children}</div>
    </div>
  );
}

const thS = { padding:"7px 10px", color:"#6b7280", fontWeight:600, borderBottom:"1.5px solid #e5e7eb", whiteSpace:"nowrap", fontSize:"0.76rem" };
const tdS = { padding:"8px 10px", borderBottom:"1px solid #f3f4f6", whiteSpace:"nowrap" };

function Comments({ items }) {
  return (
    <div style={{ display:"flex", flexDirection:"column", gap:5, marginTop:9 }}>
      {items.map(([label, text]) => text ? (
        <div key={label} style={{ display:"flex", gap:7, alignItems:"flex-start", background:"#f8fafc", borderRadius:8, padding:"7px 10px" }}>
          <span style={{ fontWeight:700, color:"#374151", whiteSpace:"nowrap", fontSize:"0.77rem", marginTop:1 }}>{label}</span>
          <span style={{ color:"#4b5563", fontSize:"0.82rem", lineHeight:1.6 }}>{text}</span>
        </div>
      ) : null)}
    </div>
  );
}

export default function App() {
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState(null);
  const [prog, setProg]       = useState(0);
  const [lastAt, setLastAt]   = useState(null);
  const timer = useRef(null);
  const kst = getKST();

  // 앱 시작 시 저장된 브리핑 불러오기
  useEffect(() => {
    try {
      const saved = localStorage.getItem("briefing_cache");
      if (saved) {
        const { data: d, lastAt: t } = JSON.parse(saved);
        setData(d);
        setLastAt(t);
      }
    } catch(e) {}
  }, []);

  async function run() {
    setLoading(true); setError(null); setProg(5);
    let p = 5;
    timer.current = setInterval(() => { p = Math.min(p + 1.2, 88); setProg(p); }, 300);
    try {
      const result = await fetchBriefing(kst);
      const savedAt = `${kst.date} ${kst.time}`;
      setProg(100); setData(result); setLastAt(savedAt);
      localStorage.setItem("briefing_cache", JSON.stringify({ data: result, lastAt: savedAt }));
    } catch(e) {
      setError(e.message);
    } finally {
      clearInterval(timer.current); setLoading(false);
    }
  }

  useEffect(() => () => clearInterval(timer.current), []);

  const krStatus = data?.kr_status;

  return (
    <div style={{ minHeight:"100vh", width:"100%", background:"linear-gradient(160deg,#0f0c29 0%,#302b63 55%,#24243e 100%)", padding:"24px 12px 48px", fontFamily:"'Noto Sans KR','Apple SD Gothic Neo',sans-serif" }}>
      <style>{`
        @keyframes spin   { to{transform:rotate(360deg);} }
        @keyframes fadeUp { from{opacity:0;transform:translateY(14px);}to{opacity:1;transform:none;} }
        @keyframes pulse  { 0%,100%{opacity:1;}50%{opacity:.35;} }
        * { box-sizing:border-box; }
        html,body,#root { width:100%; margin:0; padding:0; }
      `}</style>
      <div style={{ maxWidth:740, width:"100%", margin:"0 auto" }}>

        {/* 헤더 */}
        <div style={{ textAlign:"center", marginBottom:26 }}>
          <div style={{ display:"inline-flex", alignItems:"center", gap:6, background:"rgba(255,255,255,0.08)", borderRadius:999, padding:"5px 15px", marginBottom:11, border:"1px solid rgba(255,255,255,0.13)" }}>
            <span style={{ width:6, height:6, borderRadius:"50%", background:"#34d399", boxShadow:"0 0 7px #34d399", animation:"pulse 2s infinite", display:"inline-block" }}/>
            <span style={{ color:"#d1fae5", fontSize:"0.74rem", fontWeight:600, letterSpacing:"0.5px" }}>AI 실시간 웹검색</span>
          </div>
          <h1 style={{ color:"#fff", fontSize:"clamp(1.3rem,5vw,1.9rem)", fontWeight:900, margin:"0 0 5px", letterSpacing:"-1px" }}>
            📈 오늘의 경제 브리핑
          </h1>
          <p style={{ color:"rgba(255,255,255,0.5)", fontSize:"0.84rem", margin:"0 0 3px" }}>
            {kst.date} ({kst.weekday}) · {kst.time} KST
          </p>
          {lastAt && <p style={{ color:"rgba(255,255,255,0.3)", fontSize:"0.73rem", margin:"0 0 12px" }}>마지막 업데이트: {lastAt} KST</p>}

          {loading && (
            <div style={{ maxWidth:320, margin:"0 auto 12px" }}>
              <div style={{ background:"rgba(255,255,255,0.09)", borderRadius:999, height:4, overflow:"hidden", marginBottom:6 }}>
                <div style={{ height:"100%", background:"linear-gradient(90deg,#667eea,#a78bfa)", borderRadius:999, width:`${prog}%`, transition:"width 0.35s ease" }}/>
              </div>
              <div style={{ color:"rgba(255,255,255,0.42)", fontSize:"0.74rem" }}>지수 · 뉴스 · 분석 수집 중…</div>
            </div>
          )}

          <button onClick={run} disabled={loading} style={{
            background: loading?"rgba(255,255,255,0.07)":"linear-gradient(135deg,#667eea,#764ba2)",
            color:"#fff", border: loading?"1px solid rgba(255,255,255,0.1)":"none",
            borderRadius:12, padding:"11px 26px", fontSize:"0.91rem", fontWeight:700,
            cursor: loading?"not-allowed":"pointer",
            boxShadow: loading?"none":"0 4px 18px rgba(102,126,234,.5)",
            display:"inline-flex", alignItems:"center", gap:6, transition:"all .25s",
          }}>
            {loading
              ? <><span style={{ width:12, height:12, border:"2px solid rgba(255,255,255,.2)", borderTop:"2px solid #fff", borderRadius:"50%", animation:"spin .7s linear infinite", display:"inline-block" }}/> 분석 중…</>
              : data ? "🔄 새로고침" : "🚀 브리핑 생성하기"
            }
          </button>
        </div>

        {error && (
          <div style={{ background:"#fee2e2", borderRadius:12, padding:"12px 16px", color:"#991b1b", marginBottom:18, fontSize:"0.84rem", lineHeight:1.6 }}>⚠️ {error}</div>
        )}

        {data && (
          <div style={{ animation:"fadeUp .4s ease" }}>

            {/* 1. 뉴스 */}
            <Card icon="📰" title="오늘의 주요 경제 뉴스" accent="#fffbeb">
              {(data.news||[]).map((item,i,arr) => (
                <div key={i} style={{ display:"flex", gap:11, padding:"10px 0", borderBottom:i<arr.length-1?"1px solid #f3f4f6":"none" }}>
                  <div style={{ minWidth:23, height:23, borderRadius:"50%", background:"#1a1a2e", color:"#fff", display:"flex", alignItems:"center", justifyContent:"center", fontWeight:800, fontSize:"0.73rem", marginTop:2, flexShrink:0 }}>{i+1}</div>
                  <div>
                    <div style={{ fontWeight:700, color:"#1a1a2e", fontSize:"0.9rem", marginBottom:2 }}>{item.title}</div>
                    <div style={{ color:"#4b5563", fontSize:"0.82rem", lineHeight:1.55, marginBottom:4 }}>{item.summary}</div>
                    <div style={{ display:"flex", gap:5, flexWrap:"wrap", alignItems:"center" }}>
                      <span style={{ fontSize:"0.7rem", background:"#eff6ff", color:"#1d4ed8", borderRadius:5, padding:"1px 6px", fontWeight:600, whiteSpace:"nowrap" }}>📈 시장 영향</span>
                      <span style={{ color:"#1d4ed8", fontSize:"0.8rem" }}>{item.impact}</span>
                    </div>
                  </div>
                </div>
              ))}
            </Card>

            {/* 2. 지수 */}
            <Card icon="📊" title="지수 현황 분석" accent="#eff6ff">

              {/* 미국 지수 */}
              <div style={{ fontWeight:700, fontSize:"0.85rem", color:"#374151", marginBottom:3, display:"flex", alignItems:"center", gap:5 }}>
                🇺🇸 미국 <span style={{ fontSize:"0.7rem", color:"#9ca3af", fontWeight:400 }}>전일 종가</span>
              </div>
              {data?.sp500?.date && <div style={{ fontSize:"0.72rem", color:"#9ca3af", marginBottom:6 }}>기준일: {data.sp500.date}</div>}
              <div style={{ overflowX:"auto", marginBottom:4 }}>
                <table style={{ width:"100%", borderCollapse:"collapse", fontSize:"0.84rem" }}>
                  <thead>
                    <tr style={{ background:"#f8fafc" }}>
                      <th style={{ ...thS, textAlign:"left" }}>지수</th>
                      <th style={{ ...thS, textAlign:"right" }}>전일 종가</th>
                      <th style={{ ...thS, textAlign:"center" }}>등락률</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[["S&P 500",data?.sp500],["나스닥",data?.nasdaq100],["다우존스",data?.dow]].map(([name,spot])=>(
                      <tr key={name}>
                        <td style={{ ...tdS, fontWeight:700, color:"#1a1a2e" }}>{name}</td>
                        <td style={{ ...tdS, textAlign:"right", fontFamily:"monospace", fontWeight:700 }}>{spot?.close||"-"}</td>
                        <td style={{ ...tdS, textAlign:"center" }}><Tag v={spot?.chg}/></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Comments items={[["💬 원인",data.us_cause],["🧭 방향성",data.us_dir],["🔦 주목",data.us_sector]]}/>

              <div style={{ margin:"16px 0", borderTop:"1.5px dashed #e5e7eb" }}/>

              {/* 한국 지수 */}
              {(() => {
                const krSt = data?.kr_status;
                const krLabel = krSt==="장중"?"🟢 장중":krSt==="장후"?"🔵 장후":"⚫ 장전";
                const krDateNote = krSt==="장후" ? "금일 종가 (KRX)" : "전일 종가";
                return <div style={{ fontWeight:700, fontSize:"0.85rem", color:"#374151", marginBottom:3, display:"flex", alignItems:"center", gap:5 }}>
                  🇰🇷 한국 <span style={{ fontSize:"0.7rem", color:"#9ca3af", fontWeight:400 }}>{krLabel}</span>
                  {data?.kospi?.date && <span style={{ fontSize:"0.7rem", color:"#9ca3af", fontWeight:400, marginLeft:4 }}>· {data.kospi.date} ({krDateNote})</span>}
                </div>;
              })()}
              <div style={{ overflowX:"auto", marginBottom:4 }}>
                <table style={{ width:"100%", borderCollapse:"collapse", fontSize:"0.84rem" }}>
                  <thead>
                    <tr style={{ background:"#f8fafc" }}>
                      <th style={{ ...thS, textAlign:"left" }}>지수</th>
                      <th style={{ ...thS, textAlign:"right" }}>{data?.kr_status==="장후" ? "금일 종가" : "전일 종가"}</th>
                      <th style={{ ...thS, textAlign:"center" }}>등락률</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[["코스피",data?.kospi],["코스닥",data?.kosdaq]].map(([name,spot])=>(
                      <tr key={name}>
                        <td style={{ ...tdS, fontWeight:700, color:"#1a1a2e" }}>{name}</td>
                        <td style={{ ...tdS, textAlign:"right", fontFamily:"monospace", fontWeight:700 }}>{spot?.close||"-"}</td>
                        <td style={{ ...tdS, textAlign:"center" }}><Tag v={spot?.chg}/></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Comments items={[["💬 원인",data.kr_cause],["🧭 방향성",data.kr_dir],["🔦 주목",data.kr_sector]]}/>

              <div style={{ marginTop:14, background:"linear-gradient(135deg,#1a1a2e,#16213e)", borderRadius:12, padding:"11px 15px" }}>
                <div style={{ fontSize:"0.72rem", fontWeight:700, color:"#94a3b8", marginBottom:4 }}>📌 종합 요약</div>
                <p style={{ color:"#f1f5f9", fontSize:"0.88rem", lineHeight:1.7, margin:0, fontWeight:500 }}>{data.summary}</p>
              </div>
            </Card>

            {/* 3. 인사이트 */}
            <Card icon="💡" title="오늘의 투자 인사이트" accent="#f0fdf4">
              <div style={{ marginBottom:13 }}>
                <div style={{ fontWeight:700, color:"#374151", marginBottom:6, fontSize:"0.84rem" }}>🔍 주목 섹터 & 테마</div>
                <div style={{ display:"flex", flexDirection:"column", gap:5 }}>
                  {(data.sectors||[]).map((s,i) => (
                    <div key={i} style={{ display:"flex", gap:7, alignItems:"flex-start" }}>
                      <span style={{ background:["#dbeafe","#d1fae5","#fef3c7","#fce7f3"][i]||"#f3f4f6", color:["#1d4ed8","#065f46","#92400e","#9d174d"][i]||"#374151", borderRadius:5, padding:"1px 7px", fontWeight:700, fontSize:"0.72rem", whiteSpace:"nowrap", flexShrink:0 }}>0{i+1}</span>
                      <span style={{ color:"#374151", fontSize:"0.83rem", lineHeight:1.55 }}>{s}</span>
                    </div>
                  ))}
                </div>
              </div>
              <div style={{ marginBottom:13 }}>
                <div style={{ fontWeight:700, color:"#374151", marginBottom:6, fontSize:"0.84rem" }}>📅 경제지표 & 이벤트</div>
                <div style={{ display:"flex", flexDirection:"column", gap:4 }}>
                  {(data.events||[]).map((e,i) => {
                    const done = e.startsWith("✅") || e.includes("완료");
                    return (
                      <div key={i} style={{ display:"flex", alignItems:"flex-start", gap:5, background:done?"#f0fdf4":"#f8fafc", borderRadius:7, padding:"6px 10px", border:`1px solid ${done?"#bbf7d0":"#e5e7eb"}` }}>
                        <span style={{ fontSize:"0.75rem", marginTop:1, flexShrink:0 }}>{done?"✅":"🔮"}</span>
                        <span style={{ color:done?"#065f46":"#374151", fontSize:"0.81rem", lineHeight:1.5 }}>{e.replace(/^[✅🔮]\s?/,"")}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8 }}>
                {[["⚡ 단기","#eff6ff","#1d4ed8",data.short_term],["🌿 장기","#f0fdf4","#065f46",data.long_term]].map(([label,bg,color,text])=>(
                  <div key={label} style={{ background:bg, borderRadius:10, padding:"10px 13px" }}>
                    <div style={{ fontWeight:700, color, fontSize:"0.78rem", marginBottom:4 }}>{label} 투자자</div>
                    <p style={{ color:"#374151", fontSize:"0.81rem", lineHeight:1.6, margin:0 }}>{text}</p>
                  </div>
                ))}
              </div>
            </Card>

            {/* 4. 리스크 */}
            <Card icon="⚠️" title="오늘의 리스크 요인" accent="#fff7ed">
              <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
                {(data.risks||[]).map((r,i) => (
                  <div key={i} style={{ display:"flex", gap:8, alignItems:"flex-start", background:["#fee2e2","#fef3c7","#fff7ed","#f0fdf4"][i]||"#f8fafc", borderRadius:10, padding:"9px 13px", borderLeft:`4px solid ${["#ef4444","#f59e0b","#fb923c","#22c55e"][i]||"#94a3b8"}` }}>
                    <span style={{ flexShrink:0, marginTop:1 }}>{["🔴","🟡","🟠","🟢"][i]||"⚪"}</span>
                    <span style={{ color:"#374151", fontSize:"0.82rem", lineHeight:1.6 }}>{r}</span>
                  </div>
                ))}
              </div>
            </Card>

            <p style={{ textAlign:"center", color:"rgba(255,255,255,0.22)", fontSize:"0.7rem", lineHeight:1.8 }}>
              Claude AI 웹검색 기반 실시간 수집<br/>
              ⚠️ 참고용이며 투자 결정의 책임은 투자자 본인에게 있습니다.
            </p>
          </div>
        )}

        {!data && !loading && (
          <div style={{ textAlign:"center", color:"rgba(255,255,255,0.25)", fontSize:"0.84rem", lineHeight:2, minHeight:"60vh", display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center" }}>
            버튼을 눌러 브리핑을 생성하세요 🎯<br/>
            <span style={{ fontSize:"0.72rem", color:"rgba(255,255,255,0.15)" }}>지수 · 뉴스 · 분석 한번에</span>
          </div>
        )}

      </div>
    </div>
  );
}
