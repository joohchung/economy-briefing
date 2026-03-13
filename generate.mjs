// 브리핑 생성 스크립트 (GitHub Actions에서 실행)
import fs from "fs";

const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;
if (!ANTHROPIC_KEY) throw new Error("ANTHROPIC_KEY 환경변수 없음");

function getKST() {
  const kst = new Date(Date.now() + 9 * 3600 * 1000);
  const pad = n => String(n).padStart(2, "0");
  const days = ["일","월","화","수","목","금","토"];
  const h = kst.getUTCHours();
  const m = kst.getUTCMinutes();
  return {
    date:    `${kst.getUTCFullYear()}년 ${kst.getUTCMonth()+1}월 ${kst.getUTCDate()}일`,
    weekday: days[kst.getUTCDay()],
    time:    `${pad(h)}:${pad(m)}`,
    full:    `${kst.getUTCFullYear()}년 ${kst.getUTCMonth()+1}월 ${kst.getUTCDate()}일 (${days[kst.getUTCDay()]}) ${pad(h)}:${pad(m)} KST`,
    hour: h,
    minute: m,
  };
}

async function claudeSearch(system, user, maxIter = 4) {
  const msgs = [{ role: "user", content: user }];
  for (let i = 0; i < maxIter; i++) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 5000,
        system,
        tools: [{ type: "web_search_20250305", name: "web_search" }],
        messages: msgs,
      }),
    });
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
  return JSON.parse(text.slice(s, e + 1));
}

async function main() {
  const kst = getKST();
  const h = kst.hour;
  const m = kst.minute;
  const krClosed = h > 15 || (h === 15 && m >= 30);
  const krStatus = krClosed ? "장후" : (h >= 9 ? "장중" : "장전");
  const todayStr = `${kst.date} (${kst.weekday})`;

  const system = `당신은 실시간 경제 분석 전문가입니다.
반드시 웹검색으로 현재 시점의 실제 수치를 확인하세요.
학습된 기억 속 숫자는 절대 사용 금지.
JSON만 출력. 마크다운 없이 { 로 시작 } 로 끝.`;

  const krNote = krClosed
    ? `한국 증시 장후. 코스피/코스닥 금일 종가를 KRX 또는 네이버금융에서 확인.`
    : `한국 증시 ${krStatus}. 코스피/코스닥 전일 종가를 네이버금융에서 확인.`;

  const user = `현재: ${kst.full}
${krNote}

[검색 - 2번]
1. "S&P500 nasdaq dow jones stock price today" → 야후파이낸스 미국 전일 종가 확인
2. "${todayStr} 오늘 경제뉴스 증시" + "코스피 코스닥 ${krClosed ? "오늘 종가 KRX" : "전일 종가"}" → 반드시 오늘 ${todayStr} 날짜 뉴스만 수집

⚠️ 규칙:
- 뉴스는 반드시 오늘 ${todayStr} 날짜 기사만. 어제 뉴스 절대 금지
- 미국: 야후파이낸스 전일 종가만 (선물 불필요)
- 한국: ${krClosed ? "KRX/네이버금융 금일 종가" : "네이버금융 전일 종가"} (선물/현재가 불필요)
- 지수 date 필드: "M/D" 형식
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
  "us_cause":  "전일 미국 시장 흐름 원인 2~3줄",
  "us_dir":    "오늘 개장 방향성 2줄",
  "us_sector": "주목 섹터/종목 2줄",
  "kr_cause":  "전일 한국 시장 흐름 원인 2~3줄",
  "kr_dir":    "오늘 국내 시장 방향성 2줄",
  "kr_sector": "주목 업종/테마 2줄",
  "summary":   "핵심 포인트 2문장",
  "news": [{"title":"제목","summary":"2~3줄","impact":"1~2줄"}],
  "sectors":   ["섹터1 — 이유 2줄","섹터2 — 이유 2줄","섹터3 — 이유 2줄","섹터4 — 이유 2줄"],
  "events":    ["✅ 완료:[값] 또는 🔮 예정:(날짜 KST)"],
  "short_term":"단기 관점 2~3줄",
  "long_term": "장기 관점 2~3줄",
  "risks":     ["리스크1 — 설명 2줄","리스크2 — 설명 2줄","리스크3 — 설명 2줄","리스크4 — 설명 2줄"]
}`;

  console.log("브리핑 생성 시작:", kst.full);
  const raw = await claudeSearch(system, user);
  const data = extractJSON(raw);
  const result = {
    data,
    lastAt: `${kst.date} ${kst.time}`,
    generatedAt: new Date().toISOString(),
  };

  fs.mkdirSync("public", { recursive: true });
  fs.writeFileSync("public/briefing.json", JSON.stringify(result, null, 2));
  console.log("저장 완료:", `public/briefing.json`);
}

main().catch(e => { console.error(e); process.exit(1); });
