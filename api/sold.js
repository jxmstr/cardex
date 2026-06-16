// api/sold.js — Vercel serverless function
// Returns SOLD / completed items from eBay's Marketplace Insights API.
//
// IMPORTANT: This requires Marketplace Insights API access on your eBay keyset
// (a separate approval from Browse). Until granted, eBay returns a 403 and this
// endpoint reports that cleanly — the dashboard then shows "sold history not
// yet available" rather than fake data.
//
// Called like:  GET /api/sold?q=Monkey.D.Luffy OP01-060&grade=PSA 10&market=us

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
    body: "grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope%2Fbuy.marketplace.insights",
  });
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`token_error ${resp.status}: ${txt}`);
  }
  const data = await resp.json();
  cachedToken = data.access_token;
  tokenExpiry = now + (data.expires_in - 60) * 1000;
  return cachedToken;
}

const MARKETPLACE = { us: "EBAY_US", uk: "EBAY_GB" };

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    const { q = "", grade = "", market = "us" } = req.query;
    if (!q) return res.status(400).json({ error: "Missing q" });

    let token;
    try {
      token = await getToken();
    } catch (e) {
      // Most common: keyset lacks the marketplace.insights scope → not approved yet
      return res.status(200).json({
        available: false,
        reason: "Marketplace Insights API access not granted yet.",
        sold: [],
        stats: null,
      });
    }

    const term = `${q} ${grade}`.trim();
    const region = MARKETPLACE[String(market).toLowerCase()] || "EBAY_US";
    const url =
      "https://api.ebay.com/buy/marketplace_insights/v1_beta/item_sales/search" +
      `?q=${encodeURIComponent(term)}&category_ids=183454&limit=50`;

    const r = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-EBAY-C-MARKETPLACE-ID": region,
        "Content-Type": "application/json",
      },
    });

    if (r.status === 403) {
      return res.status(200).json({
        available: false,
        reason: "Marketplace Insights access not granted for this keyset yet.",
        sold: [],
        stats: null,
      });
    }
    if (!r.ok) {
      const txt = await r.text();
      return res.status(200).json({ available: false, reason: txt, sold: [], stats: null });
    }

    const data = await r.json();
    const items = data.itemSales || [];
    const sold = items.map((it) => ({
      title: it.title,
      price: parseFloat(it.lastSoldPrice?.value),
      currency: it.lastSoldPrice?.currency,
      date: it.lastSoldDate,
      condition: it.condition || "—",
      url: it.itemWebUrl || null,
    })).filter((s) => !isNaN(s.price));

    const prices = sold.map((s) => s.price).sort((a, b) => a - b);
    const currency = sold[0]?.currency || (region === "EBAY_GB" ? "GBP" : "USD");
    const stats = prices.length === 0 ? null : {
      count: prices.length,
      currency,
      low: prices[0],
      high: prices[prices.length - 1],
      avg: +(prices.reduce((s, n) => s + n, 0) / prices.length).toFixed(2),
      median: prices[Math.floor(prices.length / 2)],
    };

    return res.status(200).json({ available: true, sold, stats });
  } catch (err) {
    return res.status(200).json({ available: false, reason: String(err.message || err), sold: [], stats: null });
  }
}
