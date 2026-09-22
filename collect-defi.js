#!/usr/bin/env node
// collect-defi.js — Pre-filter DefiLlama protocols for Kaspa chains.
// Run hourly (or every 10 min) from your GitHub Action.
// Downloads the full /protocols list (~1 MB), filters to Kaspa chains,
// and writes a small data/defi-protocols.json (~2 KB).
//
// Usage:  node collect-defi.js
//
// Output format:
//   { "t": 1695312000000, "protocols": [
//       { "name": "KaspaDEX", "category": "DEX", "tvl": 123456,
//         "perChain": { "igra": 100000, "kasplex": 23456 },
//         "staking": false, "c1": 2.3, "c7": -1.1 },
//       ...
//   ]}

const fs = require("fs");
const path = require("path");

const OUT = path.join(__dirname, "data", "defi-protocols.json");
const KASPA_CHAINS = ["igra", "kasplex"];
const isKaspaChain = (name) => !!name && KASPA_CHAINS.includes(String(name).toLowerCase());

async function fetchJSON(url) {
  const r = await fetch(url, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

async function main() {
  console.log("Fetching DefiLlama /protocols...");
  const protos = await fetchJSON("https://api.llama.fi/protocols");
  if (!Array.isArray(protos)) throw new Error("Unexpected response");
  console.log(`  ${protos.length} total protocols`);

  const mapped = protos
    .filter((p) => Array.isArray(p.chains) && p.chains.some(isKaspaChain))
    .filter((p) => String(p.category || "").toLowerCase() !== "cex")
    .map((p) => {
      let tvl = 0;
      const ct = p.chainTvls || {};
      const perChain = {};
      for (const k in ct) {
        if (isKaspaChain(k) && isFinite(+ct[k])) {
          tvl += +ct[k];
          perChain[String(k).toLowerCase()] = +ct[k];
        }
      }
      return {
        name: p.name,
        category: p.category || null,
        tvl,
        perChain,
        staking: /stak/i.test(p.category || ""),
        c1: p.change_1d ?? null,
        c7: p.change_7d ?? null,
      };
    })
    .filter((p) => isFinite(p.tvl) && p.tvl > 0)
    .sort((a, b) => b.tvl - a.tvl);

  const out = { t: Date.now(), protocols: mapped };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out));
  console.log(`Wrote ${OUT} — ${mapped.length} Kaspa protocols (${mapped.filter((p) => p.staking).length} staking)`);
}

main().catch((e) => {
  console.error("collect-defi failed:", e);
  process.exit(1);
});
