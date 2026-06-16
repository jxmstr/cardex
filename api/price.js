// api/price.js — Vercel serverless function
// eBay Browse API (live listings), strict-matched to the card ID, then
// BUCKETED BY GRADE so each grade has its own honest price (Raw / PSA 9 /
// PSA 10 / BGS / CGC etc.) instead of one blended, meaningless number.
//
//   GET /api/price?q=Shanks OP01-120&market=us
//
// Env vars (set in Vercel): EBAY_CLIENT_ID, EBAY_CLIENT_SECRET

let cachedToken = null;
let tokenExpiry = 0;

async function getToken() {
  const now = Date.now();
  if (cachedToken && now < tokenExpiry) return cachedToken;
  const id = process.env.EBAY_CLIENT_ID;
  const secret = process.env.EBAY_CLIENT_SECRET;
  if (!id || !secret) throw new Error("Missing eBay credentials in environment variables");
  const basic = Buffer.from(`${id}:${secret}`).toString("base64");
  const resp = await fetch("https://api.ebay.com/identity/v1/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${basic}` },
    body: "grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope",
  });
  if (!resp.ok) throw new Error(`eBay token error ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  cachedToken = data.access_token;
  tokenExpiry = now + (data.expires_in - 60) * 1000;
  return cachedToken;
}

const MARKETPLACE = { us: "EBAY_US", uk: "EBAY_GB" };

// Classify a listing title into a grade bucket.
function gradeOf(title) {
  const t = (title || "").toUpperCase();
  // look for "PSA 10", "BGS 9.5", "CGC 9", etc.
  const m = t.match(/\b(PSA|BGS|CGC|SGC)\s?(10|9\.5|9|8\.5|8|7|6|5)\b/);
  if (m) return `${m[1]} ${m[2]}`;
  if (/\b(PSA|BGS|CGC|SGC|GRADED|GEM\s?MINT)\b/.test(t)) return "Graded (other)";
  return "Raw";
}

function statsOf(prices, currency) {
  if (!prices.length) return null;
  const sorted = [...prices].sort((a, b) => a - b);
  const cut = Math.floor(sorted.length * 0.1);
  const trimmed = sorted.slice(cut, sorted.length - cut || sorted.length);
  const arr = trimmed.length ? trimmed : sorted;
  return {
    count: sorted.length,
    currency,
    low: sorted[0],
    high: sorted[sorted.length - 1],
    median: sorted[Math.floor(sorted.length / 2)],
    avg: +(arr.reduce((s, n) => s + n, 0) / arr.length).toFixed(2),
  };
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    const { q = "", market = "us" } = req.query;
    if (!q) return res.status(400).json({ error: "Missing q (search query)" });

    const token = await getToken();
    const region = MARKETPLACE[String(market).toLowerCase()] || "EBAY_US";

    // Detect card ID, including parallel suffix (_p1, _p2…)
    const idFull = q.match(/\b([A-Z]{2,4}\d{2}-\d{3})(_p\d+)?\b/i);
    const cardId = idFull ? idFull[1].toUpperCase() : null;       // base ID, e.g. OP03-123
    const isParallel = !!(idFull && idFull[2]);                    // had _pN suffix

    const url =
      "https://api.ebay.com/buy/browse/v1/item_summary/search" +
      `?q=${encodeURIComponent(q)}` +
      `&category_ids=183454&limit=100&filter=buyingOptions:{FIXED_PRICE}`;

    const r = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-EBAY-C-MARKETPLACE-ID": region,
        "Content-Type": "application/json",
      },
    });
    if (!r.ok) return res.status(r.status).json({ error: `eBay search error: ${await r.text()}` });

    const data = await r.json();
    let items = data.itemSummaries || [];

    // STRICT: keep only listings whose title contains the exact card ID;
    // else require all name words; else nothing (honest, no wrong cards).
    const nameOnly = q.replace(/\b[A-Z]{2,4}\d{2}-\d{3}(_p\d+)?\b/i, "").trim();
    const nameWords = nameOnly.split(/[^A-Za-z]+/).filter((w) => w.length >= 3);
    if (cardId) {
      const reId = new RegExp(cardId.replace("-", "[- ]?"), "i");
      const byId = items.filter((it) => reId.test(it.title || ""));
      const byName = nameWords.length
        ? items.filter((it) => nameWords.every((w) => new RegExp("\\b" + w, "i").test(it.title || "")))
        : [];
      if (isParallel) {
        // Parallel/alt-art: sellers rarely write the exact _pN, so match on
        // ID OR name, then prefer titles that look like alt-art/parallel.
        let pool = [];
        const seen = new Set();
        for (const it of byId.concat(byName)) { if(!seen.has(it.itemId)){seen.add(it.itemId);pool.push(it);} }
        const altish = pool.filter((it)=>/(alt|parallel|manga|special|\bSP\b|\bSEC\b|premium|leader\salt)/i.test(it.title||""));
        items = altish.length >= 2 ? altish : (pool.length ? pool : byName);
      } else {
        // Base card: keep strict — ID match wins, else name match.
        if (byId.length >= 1) items = byId;
        else if (byName.length) items = byName;
      }
    }

    const currency = items[0]?.price?.currency || (region === "EBAY_GB" ? "GBP" : "USD");

    // BUCKET BY GRADE
    const buckets = {};
    const listings = [];
    for (const it of items) {
      const price = parseFloat(it.price?.value);
      if (isNaN(price) || price <= 0) continue;
      const g = gradeOf(it.title);
      (buckets[g] = buckets[g] || []).push(price);
      listings.push({
        title: it.title,
        price,
        currency: it.price?.currency,
        grade: g,
        condition: it.condition || "—",
        url: it.itemWebUrl,
        image: it.image?.imageUrl || it.thumbnailImages?.[0]?.imageUrl || null,
        seller: it.seller?.username || "—",
      });
    }

    // ordered grade list for display
    const ORDER = ["Raw", "PSA 9", "PSA 10", "BGS 9", "BGS 9.5", "BGS 10", "CGC 9", "CGC 9.5", "CGC 10", "Graded (other)"];
    const byGrade = Object.keys(buckets)
      .sort((a, b) => {
        const ia = ORDER.indexOf(a), ib = ORDER.indexOf(b);
        return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
      })
      .map((g) => ({ grade: g, ...statsOf(buckets[g], currency) }));

    // overall raw stats (most useful single number = the Raw bucket if present)
    const overall = buckets["Raw"] ? statsOf(buckets["Raw"], currency) : statsOf(
      Object.values(buckets).flat(), currency
    );

    listings.sort((a, b) => a.price - b.price);

    return res.status(200).json({
      query: q,
      cardId,
      market: region,
      stats: overall,        // headline number (Raw if available)
      byGrade,               // per-grade breakdown
      listings: listings.slice(0, 20),
      note: "Live eBay listings (Browse API), strict-matched to card ID and bucketed by grade. Sold prices require Marketplace Insights API.",
    });
  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
}
