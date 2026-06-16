// api/image.js — Vercel serverless function
// Proxies a One Piece card image server-side (no hotlink/CORS issues in the browser).
//
// Called like:  GET /api/image?id=OP01-060   (also handles variants like OP01-060_p1)
//
// Tries several real sources/extensions in order, because no single CDN has
// every card + alternate-art variant. The official Bandai site matches the
// card ID exactly (including _p1, _p2 suffixes), so it fills most gaps.

export default async function handler(req, res) {
  const { id = "" } = req.query;
  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    return res.status(400).json({ error: "Invalid card id" });
  }

  // Source URLs tried in order. Server-side fetch has no hotlink block.
  const sources = [
    `https://en.onepiece-cardgame.com/images/cardlist/card/${id}.png`,
    `https://static.dotgg.gg/onepiece/cards/${id}.webp`,
    `https://static.dotgg.gg/onepiece/card/${id}.webp`,
    `https://en.onepiece-cardgame.com/images/cardlist/card/${id}.jpg`,
  ];

  for (const src of sources) {
    try {
      const r = await fetch(src, {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; CardexProxy/1.0)",
          Referer: "https://en.onepiece-cardgame.com/cardlist/",
          Accept: "image/webp,image/png,image/jpeg,image/*,*/*",
        },
      });
      if (!r.ok) continue;

      const ct = r.headers.get("content-type") || "";
      if (!ct.startsWith("image/")) continue;       // skip HTML error pages

      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length < 1000) continue;               // skip tiny placeholders

      res.setHeader("Content-Type", ct);
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Cache-Control", "public, max-age=604800, immutable");
      return res.status(200).send(buf);
    } catch {
      // try next source
    }
  }

  return res.status(404).json({ error: "Image not found for " + id });
}
