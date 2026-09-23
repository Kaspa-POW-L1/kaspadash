// GoatCounter → bezoekers per continent (Cloudflare Worker)
// ------------------------------------------------------------
// Houdt de GoatCounter API-key server-side en geeft alleen
// geaggregeerde aantallen per continent terug (geen IP's, geen landen-detail).
//
// Deploy:
//   1. Cloudflare dashboard → Workers & Pages → Create → Worker
//      naam: kaspa-gc-stats  → plak deze code → Deploy
//   2. Settings → Variables and Secrets → Add → type "Secret"
//      naam: GC_TOKEN   waarde: je GoatCounter API-key
//      (GoatCounter → [gebruikersnaam] → API → New API key,
//       alleen het vinkje "Read statistics" is nodig)
//   3. Test: https://kaspa-gc-stats.<jouw-subdomein>.workers.dev/continents

const GC_SITE   = "https://zandkorrel.goatcounter.com";
const GC_PATH   = "";          // leeg laten ("") = hele site
const START     = "2023-01-01T00:00:00Z"; // vanaf wanneer tellen
const CACHE_SEC = 3600;                   // 1 uur edge-cache
const ALLOW_ORIGIN = "*";                 // eventueel beperken tot je eigen domein

const CONT = {
  AF:"AO,BF,BI,BJ,BW,CD,CF,CG,CI,CM,CV,DJ,DZ,EG,ER,ET,GA,GH,GM,GN,GQ,GW,KE,KM,LR,LS,LY,MA,MG,ML,MR,MU,MW,MZ,NA,NE,NG,RE,RW,SC,SD,SH,SL,SN,SO,SS,ST,SZ,TD,TG,TN,TZ,UG,YT,ZA,ZM,ZW,EH",
  AN:"BV,HM,AQ,TF",
  AS:"AE,AF,AM,AZ,BD,BH,BN,BT,CC,CN,CX,CY,GE,HK,ID,IL,IN,IO,IQ,IR,JO,JP,KG,KH,KP,KR,KW,KZ,LA,LB,LK,MM,MN,MO,MV,MY,NP,OM,PH,PK,PS,QA,SA,SG,SY,TH,TJ,TM,TR,TW,UZ,VN,YE,TL",
  EU:"AD,AL,AT,AX,BA,BE,BG,BY,CH,CZ,DE,DK,EE,ES,FI,FO,FR,GB,GG,GI,GR,HR,HU,IE,IM,IS,IT,JE,LI,LT,LU,LV,MC,MD,ME,MK,MT,NL,NO,PL,PT,RO,RS,RU,SE,SI,SJ,SK,SM,UA,VA,XK",
  NA:"AG,AI,AW,BB,BL,BM,BQ,BS,BZ,CA,CR,CU,CW,DM,DO,GD,GL,GP,GT,HN,HT,JM,KN,KY,LC,MF,MQ,MS,MX,NI,PA,PM,PR,SV,TC,TT,US,VC,VG,VI,SX",
  OC:"AS,AU,CK,FJ,FM,GU,KI,MH,MP,NC,NF,NR,NU,NZ,PF,PG,PW,SB,TK,TO,TV,VU,WF,WS,PN,UM",
  SA:"AR,BO,BR,CL,CO,EC,FK,GF,GS,GY,PE,PY,SR,UY,VE"
};
const C2C = {};
for (const [cont, list] of Object.entries(CONT)) for (const cc of list.split(",")) C2C[cc] = cont;

const cors = {
  "Access-Control-Allow-Origin": ALLOW_ORIGIN,
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Content-Type": "application/json; charset=utf-8",
};

async function fetchLocations(token) {
  const all = [];
  let offset = 0;
  for (let i = 0; i < 5; i++) {               // max 500 locaties, ruim genoeg
    const q = new URLSearchParams({ start: START, limit: "100", offset: String(offset) });
    if (GC_PATH) { q.append("include_paths", GC_PATH); q.set("path_by_name", "true"); }
    const r = await fetch(`${GC_SITE}/api/v0/stats/locations?${q}`, {
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    });
    if (!r.ok) throw new Error(`GoatCounter HTTP ${r.status}: ${await r.text()}`);
    const d = await r.json();
    all.push(...(d.stats || []));
    if (!d.more) break;
    offset += 100;
  }
  return all;
}

async function build(env) {
  const locs = await fetchLocations(env.GC_TOKEN);
  const cont = { AF: 0, AN: 0, AS: 0, EU: 0, NA: 0, OC: 0, SA: 0, XX: 0 };
  const countries = new Set();
  let total = 0;
  for (const s of locs) {
    const n = Number(s.count) || 0;
    const cc = String(s.id || "").slice(0, 2).toUpperCase();   // "US-CA" → "US"
    const c = C2C[cc] || "XX";                                  // XX = onbekend
    cont[c] += n;
    total += n;
    if (C2C[cc]) countries.add(cc);
  }
  return {
    total,
    countries: countries.size,
    continents: Object.entries(cont)
      .filter(([, n]) => n > 0)
      .map(([code, count]) => ({ code, count }))
      .sort((a, b) => b.count - a.count),
    since: START.slice(0, 10),
    updated: new Date().toISOString(),
  };
}

export default {
  async fetch(req, env, ctx) {
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });
    const url = new URL(req.url);
    if (url.pathname !== "/continents") return new Response('{"error":"not found"}', { status: 404, headers: cors });
    if (!env.GC_TOKEN) return new Response('{"error":"GC_TOKEN secret ontbreekt"}', { status: 500, headers: cors });

    const cache = caches.default;
    const key = new Request(url.origin + "/continents", { method: "GET" });
    const hit = await cache.match(key);
    if (hit) return hit;

    try {
      const body = JSON.stringify(await build(env));
      const res = new Response(body, { headers: { ...cors, "Cache-Control": `public, max-age=${CACHE_SEC}` } });
      ctx.waitUntil(cache.put(key, res.clone()));
      return res;
    } catch (e) {
      return new Response(JSON.stringify({ error: String(e.message || e) }), { status: 502, headers: cors });
    }
  },
};
