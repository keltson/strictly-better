export default async function handler(req, res) {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'Missing url' });

  let cards = [];
  try {
    const moxMatch = url.match(/moxfield\.com\/decks\/([^/?#]+)/);
    const archiMatch = url.match(/archidekt\.com\/decks\/(\d+)/);

    if (moxMatch) {
      const r = await fetch(`https://api2.moxfield.com/v3/decks/all/${moxMatch[1]}`, {
        headers: { 'User-Agent': 'strictly-better/1.0' },
      });
      if (!r.ok) return res.status(r.status).json({ error: 'Moxfield API error' });
      const data = await r.json();
      for (const board of ['mainboard', 'commanders']) {
        const b = data.boards?.[board]?.cards;
        if (b) for (const entry of Object.values(b)) {
          if (entry.card?.name) cards.push(entry.card.name);
        }
      }
    } else if (archiMatch) {
      const r = await fetch(`https://archidekt.com/api/decks/${archiMatch[1]}/small/`, {
        headers: { 'User-Agent': 'strictly-better/1.0' },
      });
      if (!r.ok) return res.status(r.status).json({ error: 'Archidekt API error' });
      const data = await r.json();
      for (const entry of (data.cards ?? [])) {
        if (entry.categories?.includes('Maybeboard')) continue;
        const name = entry.card?.oracleCard?.name;
        if (name) cards.push(name);
      }
    } else {
      return res.status(400).json({ error: 'Unsupported URL — use a Moxfield or Archidekt deck link' });
    }
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }

  res.json({ cards: [...new Set(cards)] });
}
