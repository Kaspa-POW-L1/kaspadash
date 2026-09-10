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
