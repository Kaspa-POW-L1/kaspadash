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
