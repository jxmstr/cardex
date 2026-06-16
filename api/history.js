// api/history.js — Vercel serverless function
// Price history for the chart, via the JustTCG API (real TCGPlayer-based history).
//
//   GET /api/history?name=Shanks&set=OP-01&duration=90d
//
// JustTCG identifies cards by name+set (slug = game·set·name·rarity), NOT by
// Bandai IDs, so we SEARCH by name (and set when possible) and take the best
// match, then return its price history points.
//
// Env var (set in Vercel, never in code): JUSTTCG_API_KEY

const BASE = "https://api.justtcg.com/v1";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const key = process.env.JUSTTCG_API_KEY;
  if (!key) return res.status(200).json({ available: false, reason: "JustTCG API key not configured", history: [] });

  const { name = "", set = "", duration = "90d" } = req.query;
  if (!name) return res.status(400).json({ error: "Missing name" });

  try {
    // Search JustTCG for this card in the One Piece game.
    // The /cards GET endpoint accepts a search query (q) + game filter.
    const params = new URLSearchParams({
      game: "one-piece-card-game",
      q: name,
      limit: "20",
      priceHistoryDuration: duration, // 7d / 30d / 90d
    });
    const r = await fetch(`${BASE}/cards?${params.toString()}`, {
      headers: { "x-api-key": key, "Content-Type": "application/json" },
    });
    if (!r.ok) {
      const txt = await r.text();
      return res.status(200).json({ available: false, reason: `JustTCG error ${r.status}: ${txt}`, history: [] });
    }
    const data = await r.json();
    let cards = data.data || [];
    if (!cards.length) return res.status(200).json({ available: false, reason: "No match found", history: [] });

    // Pick the best card match: prefer one whose set matches, else first result.
    const setNorm = set.replace(/[^a-z0-9]/gi, "").toLowerCase();
    let card =
      cards.find((c) => (c.set || c.set_name || "").replace(/[^a-z0-9]/gi, "").toLowerCase().includes(setNorm)) ||
      cards.find((c) => (c.name || "").toLowerCase() === name.toLowerCase()) ||
      cards[0];

    // From the chosen card, pick the Near Mint / Normal variant as the headline,
    // and collect any variant that has a priceHistory.
    const variants = card.variants || [];
    const pickVariant =
      variants.find((v) => /near\s*mint/i.test(v.condition || "") && /normal/i.test(v.printing || "")) ||
      variants.find((v) => /near\s*mint/i.test(v.condition || "")) ||
      variants[0];

    // Build the history series from {p,t} points (t = unix seconds).
    const rawHist =
      (pickVariant && (pickVariant.priceHistory || pickVariant.priceHistory30d)) || [];
    const history = rawHist
      .map((pt) => ({ date: new Date(pt.t * 1000).toISOString().slice(0, 10), price: pt.p }))
      .filter((h) => h.price != null);

    // Useful current stats for the card page.
    const stats = pickVariant
      ? {
          price: pickVariant.price,
          change7d: pickVariant.priceChange7d ?? null,
          change30d: pickVariant.priceChange30d ?? null,
          change90d: pickVariant.priceChange90d ?? null,
          avg30d: pickVariant.avgPrice30d ?? null,
          min90d: pickVariant.minPrice90d ?? null,
          max90d: pickVariant.maxPrice90d ?? null,
          minAllTime: pickVariant.minPriceAllTime ?? null,
          maxAllTime: pickVariant.maxPriceAllTime ?? null,
          currency: "USD",
        }
      : null;

    return res.status(200).json({
      available: true,
      matched: { name: card.name, set: card.set_name || card.set, rarity: card.rarity },
      condition: pickVariant?.condition || null,
      printing: pickVariant?.printing || null,
      stats,
      history,
      source: "JustTCG (TCGPlayer-based)",
    });
  } catch (err) {
    return res.status(200).json({ available: false, reason: String(err.message || err), history: [] });
  }
}
