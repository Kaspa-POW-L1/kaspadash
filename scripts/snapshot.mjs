// Takes one snapshot of Kaspa network metrics and appends it to data/history.json.
// Runs on Node 20+ (global fetch). No dependencies. Invoked by the GitHub Action.

import { readFile, writeFile, mkdir } from "node:fs/promises";

const KAS = "https://api.kaspa.org";
const OUT = "data/history.json";
const MAX_AGE_DAYS = 90;   // keep ~3 months of hourly points (~2,200 rows)
const HARD_CAP = 6000;     // safety cap on total rows

async function j(url) {
  const r = await fetch(url, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(url + " -> HTTP " + r.status);
  return r.json();
}
const num = (x) => (x == null ? NaN : Number(String(x).replace(/[, ]/g, "")));
const pick = (o, keys) => { for (const k of keys) if (o && o[k] != null) return o[k]; return null; };

const rec = { t: Date.now() };

try {
  const s = await j(KAS + "/info/coinsupply");
  let c = num(pick(s, ["circulatingSupply", "circulating"]));
  if (c > 1e15) c /= 1e8; // sompi -> KAS
  rec.supply = c;
} catch (e) { console.warn("supply:", e.message); }

try {
  const d = await j(KAS + "/info/hashrate?stringOnly=false");
  rec.hashrate = num(pick(d, ["hashrate"])); // TH/s
} catch (e) { console.warn("hashrate:", e.message); }

try {
  const d = await j(KAS + "/info/price?stringOnly=false");
  rec.price = num(pick(d, ["price"])); // USD
} catch (e) { console.warn("price:", e.message); }

try {
  const d = await j(KAS + "/info/blockreward?stringOnly=false");
  rec.reward = num(pick(d, ["blockreward", "blockReward"]));
} catch (e) { console.warn("reward:", e.message); }

try {
  const d = await j(KAS + "/info/blockdag");
  rec.difficulty = num(pick(d, ["difficulty"]));
} catch (e) { console.warn("difficulty:", e.message); }

// Peer prices (CoinGecko) for relative-performance history. Optional: if this
// fails (e.g. CoinGecko rate-limits the Action IP), we simply skip peers this hour.
try {
  const CG = "https://api.coingecko.com/api/v3";
  const PEER_IDS = ["kaspa","bitcoin","litecoin","monero","dogecoin","solana","avalanche-2","near","sui","aptos"];
  const d = await j(CG + "/coins/markets?vs_currency=usd&ids=" + PEER_IDS.join(",") + "&per_page=50&page=1");
  if (Array.isArray(d) && d.length) {
    const p = {};
    d.forEach(c => { if (c && isFinite(c.current_price)) p[c.id] = c.current_price; });
    if (Object.keys(p).length) rec.peers = p;
  }
} catch (e) { console.warn("peers:", e.message); }

if (isFinite(rec.price) && isFinite(rec.supply)) rec.marketcap = rec.price * rec.supply;

// normalise NaN -> null so the JSON stays clean
for (const k of Object.keys(rec)) {
  if (typeof rec[k] === "number" && !isFinite(rec[k])) rec[k] = null;
}

// bail out if the whole snapshot is empty (API outage) — don't pollute history
const hasData = ["supply", "hashrate", "price", "reward", "difficulty"].some((k) => rec[k] != null);
if (!hasData) { console.error("no data fetched — skipping write"); process.exit(0); }

let hist = [];
try {
  hist = JSON.parse(await readFile(OUT, "utf8"));
  if (!Array.isArray(hist)) hist = [];
} catch { /* first run */ }

hist.push(rec);

const cutoff = Date.now() - MAX_AGE_DAYS * 864e5;
hist = hist.filter((r) => r && typeof r.t === "number" && r.t >= cutoff);
if (hist.length > HARD_CAP) hist = hist.slice(hist.length - HARD_CAP);

await mkdir("data", { recursive: true });
await writeFile(OUT, JSON.stringify(hist));
console.log("snapshot ok", new Date(rec.t).toISOString(), "| rows:", hist.length);

// KRC-20 token growth: crawl the full token list (paginated) and bucket by
// deploy date (mtsAdd). One crawl yields the entire per-day history, so we only
// recompute about once a day to keep hourly runs cheap.
try {
  const TOK = "data/tokens-daily.json";
  let existing = null;
  try { existing = JSON.parse(await readFile(TOK, "utf8")); } catch { /* first run */ }
  const stale = !existing || !existing.updated || (Date.now() - existing.updated) > 20 * 3600e3;
  if (stale) {
    const LIST = "https://api.kasplex.org/v1/krc20/tokenlist";
    const daily = {};
    let total = 0, cursor = null, pages = 0;
    while (pages < 300) {
      const url = cursor ? LIST + "?next=" + encodeURIComponent(cursor) : LIST;
      const d = await j(url);
      const list = (d && d.result) || [];
      if (!list.length) break;
      for (const t of list) {
        total++;
        const ms = Number(t.mtsAdd);
        if (isFinite(ms) && ms > 0) {
          const day = new Date(ms).toISOString().slice(0, 10);
          daily[day] = (daily[day] || 0) + 1;
        }
      }
      pages++;
      if (!d.next || d.next === cursor) break;
      cursor = d.next;
    }
    if (total > 0) {
      const cut = new Date(Date.now() - 120 * 864e5).toISOString().slice(0, 10);
      const trimmed = {};
      Object.keys(daily).forEach(k => { if (k >= cut) trimmed[k] = daily[k]; });
      await writeFile(TOK, JSON.stringify({ updated: Date.now(), total, daily: trimmed }));
      console.log("tokens-daily ok | total:", total, "| pages:", pages);
    }
  } else {
    console.log("tokens-daily fresh — skipping crawl");
  }
} catch (e) { console.warn("tokens-daily:", e.message); }

// Fear & Greed history (crypto + stock market)
// alternative.me gives up to 30 days of crypto F&G for free.
// CNN stock F&G has no official API; we scrape the public JSON endpoint.
try {
  const FNG = "data/fng-history.json";
  let fngHist = [];
  try { fngHist = JSON.parse(await readFile(FNG, "utf8")); if(!Array.isArray(fngHist)) fngHist=[]; } catch {}

  // crypto F&G — last 30 days from alternative.me
  const cr = await j("https://api.alternative.me/fng/?limit=30&format=json");
  const cryptoPoints = (cr.data||[]).map(d=>({
    t: Number(d.timestamp)*1000,
    crypto: Number(d.value),
    label: d.value_classification
  })).filter(d=>isFinite(d.t)&&isFinite(d.crypto));

  // stock F&G — CNN Fear & Greed (unofficial public JSON)
  let stockVal = null;
  try {
    const s = await j("https://production.dataviz.cnn.io/index/fearandgreed/graphdata");
    stockVal = s && s.fear_and_greed && isFinite(s.fear_and_greed.score)
      ? Math.round(s.fear_and_greed.score) : null;
  } catch(e2) { console.warn("stock-fng:", e2.message); }

  // merge: map crypto points by date, add today's stock value
  const byDay = {};
  cryptoPoints.forEach(p=>{
    const day = new Date(p.t).toISOString().slice(0,10);
    byDay[day] = { t: p.t, crypto: p.crypto, label: p.label };
  });
  if(stockVal!=null){
    const today = new Date().toISOString().slice(0,10);
    if(byDay[today]) byDay[today].stock = stockVal;
    else byDay[today] = { t: Date.now(), stock: stockVal };
  }

  // merge with existing history (keep 90 days)
  const cut = Date.now() - 90*864e5;
  const newPoints = Object.values(byDay).filter(p=>p.t>=cut);
  const existingDays = new Set(fngHist.map(p=>new Date(p.t).toISOString().slice(0,10)));
  newPoints.forEach(p=>{
    const day = new Date(p.t).toISOString().slice(0,10);
    if(!existingDays.has(day)) fngHist.push(p);
    else { const i=fngHist.findIndex(x=>new Date(x.t).toISOString().slice(0,10)===day); if(i>=0) fngHist[i]={...fngHist[i],...p}; }
  });
  fngHist = fngHist.filter(p=>p.t>=cut).sort((a,b)=>a.t-b.t);
  await writeFile(FNG, JSON.stringify(fngHist));
  console.log("fng-history ok | points:", fngHist.length, "| stock:", stockVal??'n/a');
} catch(e) { console.warn("fng-history:", e.message); }
