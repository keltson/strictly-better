#!/usr/bin/env node
// Generates card-cache.json from card-pairs.json.
// Fetches static card metadata (images, oracle text, types, etc.) from Scryfall.
// Prices are intentionally excluded — they are fetched live and cached in the browser.
//
// Usage:
//   node scripts/build-cache.js
//
// Requirements: Node 18+ (uses built-in fetch)

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PAIRS_PATH = path.join(ROOT, 'card-pairs.json');
const CACHE_PATH = path.join(ROOT, 'card-cache.json');
const BATCH_SIZE = 75;
const BATCH_DELAY_MS = 150;

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function getImageUri(card) {
  if (card.image_uris) return card.image_uris.normal;
  if (card.card_faces?.[0]?.image_uris) return card.card_faces[0].image_uris.normal;
  return null;
}

function extractStaticFields(card) {
  const faces = card.card_faces;
  return {
    name: card.name,
    image: getImageUri(card),
    url: card.scryfall_uri,
    oracle: (faces
      ? faces.map(f => f.oracle_text ?? '').join('\n')
      : (card.oracle_text ?? '')
    ).toLowerCase(),
    type: (faces
      ? faces.map(f => f.type_line ?? card.type_line ?? '').join(' // ')
      : (card.type_line ?? '')
    ).toLowerCase(),
    colors: card.colors ?? [],
    colorIdentity: card.color_identity ?? [],
    cmc: card.cmc ?? 0,
    rarity: card.rarity ?? '',
    keywords: (card.keywords ?? []).map(k => k.toLowerCase()),
    legalities: card.legalities ?? {},
    power: card.power ?? null,
    toughness: card.toughness ?? null,
    set: card.set ?? '',
    manaCost: ((faces ? faces[0]?.mana_cost : card.mana_cost) ?? '').toLowerCase(),
  };
}

// Scryfall collection API rejects '// back face' DFC names — use front face only
function scryfallName(name) {
  return name.includes(' // ') ? name.split(' // ')[0] : name;
}

async function fetchBatch(names) {
  // Map scryfall lookup name → original name for DFCs
  const lookup = Object.fromEntries(names.map(n => [scryfallName(n), n]));
  const res = await fetch('https://api.scryfall.com/cards/collection', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'strictly-better-cache-builder/1.0' },
    body: JSON.stringify({ identifiers: Object.keys(lookup).map(name => ({ name })) }),
  });
  if (!res.ok) throw new Error(`Scryfall HTTP ${res.status}`);
  const json = await res.json();
  if (json.warnings?.length) {
    for (const w of json.warnings) console.warn('  Scryfall warning:', w);
  }
  // Re-key cards by original name (restores the full DFC name where needed)
  return (json.data ?? []).map(card => ({ ...card, name: lookup[card.name] ?? card.name }));
}

async function main() {
  if (!fs.existsSync(PAIRS_PATH)) {
    console.error(`card-pairs.json not found at ${PAIRS_PATH}`);
    process.exit(1);
  }

  const pairs = JSON.parse(fs.readFileSync(PAIRS_PATH, 'utf8'));

  // Collect unique names preserving insertion order
  const seen = new Set();
  const nameList = [];
  for (const [better, ...worse] of pairs) {
    if (!seen.has(better)) { seen.add(better); nameList.push(better); }
    for (const w of worse) {
      if (!seen.has(w)) { seen.add(w); nameList.push(w); }
    }
  }
  console.log(`Found ${nameList.length} unique card names in card-pairs.json`);

  const chunks = [];
  for (let i = 0; i < nameList.length; i += BATCH_SIZE)
    chunks.push(nameList.slice(i, i + BATCH_SIZE));

  const cards = {};
  let done = 0;
  let notFound = 0;

  for (let i = 0; i < chunks.length; i++) {
    process.stdout.write(`\rFetching batch ${i + 1}/${chunks.length} (${done}/${nameList.length} cards)...`);
    try {
      const results = await fetchBatch(chunks[i]);
      for (const card of results) {
        cards[card.name] = extractStaticFields(card);
      }
      const missing = chunks[i].length - results.length;
      if (missing > 0) {
        notFound += missing;
        const foundNames = new Set(results.map(c => c.name));
        const missingNames = chunks[i].filter(n => !foundNames.has(n));
        for (const n of missingNames) console.warn(`\n  Not found on Scryfall: "${n}"`);
      }
    } catch (e) {
      console.error(`\n  Batch ${i + 1} failed: ${e.message}`);
    }
    done = Math.min(done + BATCH_SIZE, nameList.length);
    if (i < chunks.length - 1) await sleep(BATCH_DELAY_MS);
  }

  process.stdout.write(`\r`);
  console.log(`Fetched ${Object.keys(cards).length} cards (${notFound} not found on Scryfall)`);

  const output = {
    generated: new Date().toISOString(),
    count: Object.keys(cards).length,
    cards,
  };

  fs.writeFileSync(CACHE_PATH, JSON.stringify(output, null, 2), 'utf8');
  console.log(`Wrote card-cache.json`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
