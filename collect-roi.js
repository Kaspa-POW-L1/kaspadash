#!/usr/bin/env node
// collect-roi.js — Fetch historical KAS prices for the ROI table.
// Run daily from your GitHub Action alongside the existing collectors.
// Writes data/roi.json with one entry per period.
//
// Usage:  node collect-roi.js [CG_API_KEY]
//   or set env CG_API_KEY=demo
//
// Output format:
//   { "t": 1695312000000, "periods": [
//       { "label": "1 week ago",   "days": 7,   "price": 0.0412 },
//       { "label": "1 month ago",  "days": 30,  "price": 0.0389 },
//       ...
//   ]}

const fs = require("fs");
const path = require("path");

const API_KEY = process.argv[2] || process.env.CG_API_KEY || "demo";
const BASE = "https://api.coingecko.com/api/v3";
const OUT = path.join(__dirname, "data", "roi.json");

const PERIODS = [
  { label: "1 week ago",    days: 7 },
  { label: "1 month ago",   days: 30 },
  { label: "3 months ago",  days: 90 },
  { label: "6 months ago",  days: 180 },
  { label: "1 year ago",    days: 365 },
  { label: "2 years ago",   days: 730 },
];

function fmtDate(daysAgo) {
  const dt = new Date(Date.now() - daysAgo * 86400000);
  return `${String(dt.getDate()).padStart(2, "0")}-${String(dt.getMonth() + 1).padStart(2, "0")}-${dt.getFullYear()}`;
}

async function fetchJSON(url) {
  const r = await fetch(url, {
    headers: { accept: "application/json", "x-cg-demo-api-key": API_KEY },
  });
  if (r.status === 429) throw new Error("Rate limited (429)");
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const periods = [];

  for (const p of PERIODS) {
    const date = fmtDate(p.days);
    try {
      const d = await fetchJSON(`${BASE}/coins/kaspa/history?date=${date}&localization=false`);
      const price = d?.market_data?.current_price?.usd ?? null;
      periods.push({ label: p.label, days: p.days, price });
      console.log(`  ${p.label} (${date}): $${price ?? "n/a"}`);
    } catch (e) {
      console.warn(`  ${p.label} (${date}): FAILED — ${e.message}`);
      periods.push({ label: p.label, days: p.days, price: null });
    }
    await sleep(1500); // stay well under CoinGecko rate limit
  }

  const out = { t: Date.now(), periods };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out));
  console.log(`Wrote ${OUT} (${periods.filter((p) => p.price != null).length}/${periods.length} prices)`);
}

main().catch((e) => {
  console.error("collect-roi failed:", e);
  process.exit(1);
});
