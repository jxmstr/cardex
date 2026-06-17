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

  const { name = "", set = "", number = "", duration = "90d", parallel = "" } = req.query;
  if (!name && !number) return res.status(400).json({ error: "Missing name/number" });
  const isParallel = parallel === "1" || /_p\d/i.test(name);

  try {
    // Search JustTCG for this card in the One Piece game.
    // The /cards GET endpoint accepts a search query (q) + game filter.
    const params = new URLSearchParams({
      game: "one-piece-card-game",
      limit: "20",
      priceHistoryDuration: duration,
    });
    if (name) params.set("q", name);
    if (number) params.set("number", number);   // exact card-number match (key fix)
    if (set) params.set("set", set);            // narrow to the set
    const r = await fetch(`${BASE}/cards?${params.toString()}`, {
      headers: { "x-api-key": key, "Content-Type": "application/json" },
    });
    if (!r.ok) {
      const txt = await r.text();
      return res.status(200).json({ available: false, reason: `JustTCG error ${r.status}: ${txt}`, history: [] });
    }
    const data = await r.json();
    let cards = data.data || [];
    if (!cards.length) return res.status(200).json({ available: false, reason: "No match found on JustTCG", history: [] });

    // Restrict to cards whose name matches (avoid unrelated results).
    const nameNorm = name.replace(/_p\d+/i,"").replace(/[^a-z0-9]/gi, "").toLowerCase();
    const setNorm = set.replace(/[^a-z0-9]/gi, "").toLowerCase();
    const nameMatches = cards.filter((c)=> (c.name||"").replace(/[^a-z0-9]/gi,"").toLowerCase().includes(nameNorm) || nameNorm.includes((c.name||"").replace(/[^a-z0-9]/gi,"").toLowerCase()));
    const pool = nameMatches.length ? nameMatches : cards;

    // Flatten all (card,variant) pairs with Near Mint preference, carrying price.
    const nm = (v) => /near\s*mint/i.test(v.condition || "");
    const foil = (v) => /(foil|holo|parallel|alt|manga)/i.test(v.printing || "");
    let pairs = [];
    for (const c of pool) {
      const setHit = (c.set||c.set_name||"").replace(/[^a-z0-9]/gi,"").toLowerCase().includes(setNorm);
      for (const v of (c.variants||[])) {
        if (v.price==null) continue;
        pairs.push({ c, v, setHit, isFoil:foil(v), isNM:nm(v), price:v.price });
      }
    }
    if (!pairs.length) return res.status(200).json({ available:false, reason:"Matched a card but it had no priced variants.", history:[] });

    // Prefer set match, then Near Mint.
    const tier = (p)=> (p.setHit?2:0) + (p.isNM?1:0);
    let pick;
    if (isParallel) {
      // Parallel/alt-art: prefer foil/alt printing; among those, the HIGHER price
      // (manga/alt parallels are the expensive ones, not the base).
      const foils = pairs.filter(p=>p.isFoil);
      const cand = foils.length ? foils : pairs;
      pick = cand.sort((a,b)=> (tier(b)-tier(a)) || (b.price-a.price))[0];
    } else {
      // Base card: prefer Normal printing + set match + Near Mint; typical (not max) price.
      const normals = pairs.filter(p=>!p.isFoil);
      const cand = normals.length ? normals : pairs;
      pick = cand.sort((a,b)=> (tier(b)-tier(a)))[0];
    }
    const card = pick.c;
    const pickVariant = pick.v;

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
      marketPrice: pickVariant ? pickVariant.price : null,
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
