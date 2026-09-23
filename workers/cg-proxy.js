/**
 * worker.js — CoinGecko-proxy voor het Kaspa-dashboard
 * ----------------------------------------------------
 * Doel:
 *   1. Houdt je CoinGecko API-key GEHEIM (server-side, nooit in de pagina).
 *   2. Cachet antwoorden aan de Cloudflare-edge, zodat ALLE bezoekers samen
 *      dezelfde gecachte data delen. Eén echte call per endpoint per TTL,
 *      voor je hele publiek → ruim binnen de gratis Demo-limieten.
 *
 * Deploy (gratis, ~2 min):
 *   1. dash.cloudflare.com → Workers & Pages → Create → Worker → naam bijv. "kaspa-cg-proxy"
 *   2. Plak deze hele file als de Worker-code en klik Deploy.
 *   3. Settings → Variables and Secrets → Add → type "Secret":
 *        Name:  CG_API_KEY
 *        Value: <je CoinGecko Demo API-key>
 *      Opslaan en opnieuw Deployen.
 *   4. Kopieer de URL (bijv. https://kaspa-cg-proxy.<jouw-subdomein>.workers.dev)
 *      en zet die in index.html bij de CG-constante (zie daar de comment).
 *
 * Heb je een BETAALDE (Pro) key i.p.v. Demo? Wissel dan UPSTREAM en KEY_HEADER
 * om naar de pro-varianten hieronder.
 */

const UPSTREAM   = "https://api.coingecko.com";   // Pro-key? → "https://pro-api.coingecko.com"
const KEY_HEADER = "x-cg-demo-api-key";           // Pro-key? → "x-cg-pro-api-key"

// Wil je de proxy dichttimmeren zodat alleen jouw site 'm mag gebruiken?
// Zet hier je eigen origin, bijv. "https://jouwdomein.nl". "*" = iedereen mag.
const ALLOW_ORIGIN = "*";

// Cache-tijd (seconden) per soort endpoint. Meer caching = minder echte calls.
function ttlFor(path){
  if (path.includes("/history"))      return 21600; // historische datum: verandert niet meer → 6 uur
  if (path.includes("/market_chart")) return 1800;  // 365d-grafiek: langzaam → 30 min
  if (path.includes("/simple/price")) return 60;    // live prijs → 1 min
  if (path.includes("/global"))       return 120;   // marktbreed → 2 min
  return 90;                                         // rest (markets, tickers, coin-detail) → 1,5 min
}

const CORS = {
  "Access-Control-Allow-Origin":  ALLOW_ORIGIN,
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "accept",
  "Vary": "Origin",
};

export default {
  async fetch(request, env, ctx){
    if (request.method === "OPTIONS")
      return new Response(null, { status: 204, headers: CORS });
    if (request.method !== "GET")
      return new Response("Method Not Allowed", { status: 405, headers: CORS });

    const url = new URL(request.url);

    // Alleen de CoinGecko v3-API doorlaten — geen open proxy naar willekeurige URL's.
    if (!url.pathname.startsWith("/api/v3/"))
      return new Response("Not Found", { status: 404, headers: CORS });

    const upstreamUrl = UPSTREAM + url.pathname + url.search;
    const cache = caches.default;
    const cacheKey = new Request(upstreamUrl, { method: "GET" });

    // Cache-hit: eerste bezoeker triggert de echte call, de rest deelt 'm.
    const hit = await cache.match(cacheKey);
    if (hit){
      const r = new Response(hit.body, hit);
      r.headers.set("x-proxy-cache", "HIT");
      for (const [k, v] of Object.entries(CORS)) r.headers.set(k, v);
      return r;
    }

    const fwd = { accept: "application/json" };
    if (env.CG_API_KEY) fwd[KEY_HEADER] = env.CG_API_KEY;

    let upstream;
    try {
      upstream = await fetch(upstreamUrl, { headers: fwd });
    } catch (e) {
      return new Response(JSON.stringify({ error: "upstream unreachable" }),
        { status: 502, headers: { ...CORS, "content-type": "application/json" } });
    }

    const body = await upstream.arrayBuffer();
    const ok   = upstream.ok;
    const ttl  = ok ? ttlFor(url.pathname) : 0;

    const out = new Response(body, {
      status: upstream.status,
      headers: {
        "content-type":  upstream.headers.get("content-type") || "application/json",
        "cache-control": ok ? `public, max-age=${ttl}` : "no-store",
        "x-proxy-cache": "MISS",
        ...CORS,
      },
    });

    // Alleen geslaagde antwoorden cachen — zo zetten we nooit een 429/5xx vast.
    if (ok) ctx.waitUntil(cache.put(cacheKey, out.clone()));
    return out;
  },
};
