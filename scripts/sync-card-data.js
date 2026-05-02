#!/usr/bin/env node
// Syncs card-pairs.json and card-cache.json.
//
// Step 1: Fetches "strictly better/worse" card pairs from the Scryfall Tagger GraphQL API
// Step 2: Fetches metadata for any new cards from the Scryfall REST API
//
// Usage: node scripts/sync-card-data.js

'use strict';

const fs   = require('fs');
const path = require('path');
const https = require('https');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const ROOT       = path.join(__dirname, '..');
const PAIRS_PATH = path.join(ROOT, 'card-pairs.json');
const CACHE_PATH = path.join(ROOT, 'card-cache.json');
const PAIRS_TMP  = PAIRS_PATH + '.tmp';
const CACHE_TMP  = CACHE_PATH + '.tmp';

const TAGGER_GQL        = 'https://tagger.scryfall.com/graphql';
const SCRYFALL_COLLECT  = 'https://api.scryfall.com/cards/collection';

const SCRYFALL_BATCH    = 75;   // Scryfall collection API max per request
const SCRYFALL_DELAY    = 100;  // ms between Scryfall API calls (required: 50–100ms)
const TAGGER_DELAY      = 300;  // ms between tagger pages (be polite)
const EDHREC_CONCURRENCY = 8;   // parallel EDHRec requests
const USER_AGENT        = 'strictly-better-sync/1.0 (github.com/keltson/strictly-better)';

const SEARCH_EDGES_QUERY = `
  query SearchEdges($input: EdgeSearchInput!) {
    edges(input: $input) {
      page
      perPage
      total
      results {
        classifier
        subjectName
        relatedName
      }
    }
  }
`;

// ---------------------------------------------------------------------------
// Card field extraction (mirrors build-cache.js — keeps card-cache.json small)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// HTTP helpers (no external dependencies)
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function get(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      { hostname: u.hostname, path: u.pathname + u.search, method: 'GET', headers: { 'User-Agent': USER_AGENT, ...headers } },
      res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') })
        );
      }
    );
    req.on('error', reject);
    req.end();
  });
}

function postJson(url, body, extraHeaders = {}) {
  const data = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: 'POST',
        headers: {
          'Content-Type':   'application/json',
          'Content-Length': Buffer.byteLength(data),
          'User-Agent':     USER_AGENT,
          'Origin':         'https://tagger.scryfall.com',
          'Referer':        'https://tagger.scryfall.com/',
          'Accept':         'application/json',
          ...extraHeaders,
        },
      },
      res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') })
        );
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function parseJson(raw, context) {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${context} returned non-JSON: ${raw.slice(0, 300)}`);
  }
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function loadJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    console.warn(`Warning: could not parse ${path.basename(filePath)}: ${e.message}`);
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Step 1 — Fetch pairs from Scryfall Tagger GraphQL API
// ---------------------------------------------------------------------------

// Fetch the tagger homepage to obtain the CSRF token and session cookie.
async function getTaggerSession() {
  const res = await get('https://tagger.scryfall.com/');
  if (res.status !== 200) {
    throw new Error(`Failed to load tagger.scryfall.com (HTTP ${res.status})`);
  }

  // Extract CSRF token from <meta name="csrf-token" content="...">
  const match = res.body.match(/<meta[^>]+name=["']csrf-token["'][^>]+content=["']([^"']+)["']/i)
             || res.body.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']csrf-token["']/i);
  if (!match) {
    throw new Error('Could not find CSRF token on tagger.scryfall.com — page structure may have changed.');
  }
  const csrfToken = match[1];

  // Collect Set-Cookie headers into a single cookie string
  const setCookie = res.headers['set-cookie'] ?? [];
  const cookie = setCookie.map(c => c.split(';')[0]).join('; ');

  return { csrfToken, cookie };
}

async function fetchTaggerPage(page, csrfToken, cookie) {
  const res = await postJson(TAGGER_GQL, {
    query: SEARCH_EDGES_QUERY,
    variables: {
      input: {
        classifier: ['BETTER_THAN', 'WORSE_THAN'],
        type: 'RELATIONSHIP',
        name: null,
        page,
      },
    },
    operationName: 'SearchEdges',
  }, { 'X-CSRF-Token': csrfToken, 'Cookie': cookie });

  if (res.status !== 200) {
    throw new Error(`Tagger GraphQL returned HTTP ${res.status} on page ${page}: ${res.body.slice(0, 400)}`);
  }

  const json = parseJson(res.body, 'Tagger GraphQL');

  if (json.errors?.length) {
    throw new Error(`Tagger GraphQL errors: ${json.errors.map(e => e.message).join('; ')}`);
  }

  return json.data.edges;
}

async function fetchAllPairs() {
  console.log('=== Step 1: Fetching pairs from Scryfall Tagger GraphQL ===');

  process.stdout.write('  Obtaining CSRF token…');
  const { csrfToken, cookie } = await getTaggerSession();
  process.stdout.write(' done\n');

  const allPairs = [];
  let page = 1;
  let total = null;

  while (true) {
    process.stdout.write(`  Page ${page}${total !== null ? `/${Math.ceil(total / 100)}` : ''}…`);

    const edges = await fetchTaggerPage(page, csrfToken, cookie);

    if (total === null) total = edges.total;

    const results = edges.results ?? [];
    process.stdout.write(` ${results.length} edges\n`);

    for (const edge of results) {
      if (edge.classifier === 'BETTER_THAN') {
        allPairs.push({ better: edge.subjectName, worse: edge.relatedName });
      } else if (edge.classifier === 'WORSE_THAN') {
        // Flip: "A is worse than B" → { better: B, worse: A }
        allPairs.push({ better: edge.relatedName, worse: edge.subjectName });
      }
    }

    // Stop when we've seen all records
    if (page * edges.perPage >= edges.total) break;

    page++;
    await sleep(TAGGER_DELAY);
  }

  if (allPairs.length === 0) {
    throw new Error('Tagger returned 0 edges — aborting to avoid overwriting good data.');
  }

  // Deduplicate: keep first occurrence of each [better, worse] combo
  const seen = new Set();
  const deduped = [];
  for (const pair of allPairs) {
    const key = `${pair.better}\0${pair.worse}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(pair);
    }
  }

  const dupes = allPairs.length - deduped.length;
  console.log(
    `  Total: ${allPairs.length} edges → ${deduped.length} unique pairs` +
    (dupes > 0 ? ` (${dupes} duplicates removed)` : '')
  );
  return deduped;
}

// ---------------------------------------------------------------------------
// Step 2 — Fetch Scryfall card metadata
// ---------------------------------------------------------------------------

function collectUniqueNames(pairs) {
  const seen = new Set();
  const names = [];
  for (const { better, worse } of pairs) {
    if (!seen.has(better)) { seen.add(better); names.push(better); }
    if (!seen.has(worse))  { seen.add(worse);  names.push(worse);  }
  }
  return names;
}

// Scryfall collection API rejects "Name // Back Face" — use front face only.
function scryfallLookupName(name) {
  return name.includes(' // ') ? name.split(' // ')[0].trim() : name;
}

async function fetchScryfallBatch(names) {
  const lookupToOriginal = new Map(names.map(n => [scryfallLookupName(n), n]));
  const identifiers = [...lookupToOriginal.keys()].map(name => ({ name }));

  const res = await postJson(SCRYFALL_COLLECT, { identifiers });

  if (res.status !== 200) {
    throw new Error(`Scryfall collection API returned HTTP ${res.status}`);
  }

  const json = parseJson(res.body, 'Scryfall collection API');

  if (json.warnings?.length) {
    for (const w of json.warnings) console.warn(`    Scryfall warning: ${w}`);
  }

  const cards = {};
  for (const card of json.data ?? []) {
    const original = lookupToOriginal.get(card.name) ?? card.name;
    cards[original] = card;
  }

  for (const original of names) {
    if (!cards[original]) {
      console.warn(`    Not found on Scryfall: "${original}"`);
    }
  }

  return cards;
}

async function updateCache(pairs, rawCache) {
  console.log('\n=== Step 2: Updating card-cache.json ===');

  // Support both { cards: {...} } (build-cache.js format) and flat { CardName: {...} }
  const existingCards = (rawCache.cards && typeof rawCache.cards === 'object')
    ? rawCache.cards
    : rawCache;

  const allNames  = collectUniqueNames(pairs);
  const newNames  = allNames.filter(n => !(n in existingCards));
  const skipCount = allNames.length - newNames.length;

  console.log(`  Total unique cards in pairs : ${allNames.length}`);
  console.log(`  Already in cache (skipping) : ${skipCount}`);
  console.log(`  New cards to fetch          : ${newNames.length}`);

  if (newNames.length === 0) {
    console.log('  Nothing to fetch — cache is up to date.');
    return { generated: new Date().toISOString(), count: Object.keys(existingCards).length, cards: existingCards };
  }

  const merged = { ...existingCards };

  const chunks = [];
  for (let i = 0; i < newNames.length; i += SCRYFALL_BATCH) {
    chunks.push(newNames.slice(i, i + SCRYFALL_BATCH));
  }

  let fetched = 0;
  for (let i = 0; i < chunks.length; i++) {
    process.stdout.write(`  Batch ${i + 1}/${chunks.length} (${chunks[i].length} cards)…`);

    let batch;
    try {
      batch = await fetchScryfallBatch(chunks[i]);
    } catch (e) {
      throw new Error(`Scryfall batch ${i + 1} failed: ${e.message}`);
    }

    const count = Object.keys(batch).length;
    process.stdout.write(` ${count} returned\n`);
    for (const [name, card] of Object.entries(batch)) {
      merged[name] = extractStaticFields(card);
    }
    fetched += count;

    if (i < chunks.length - 1) await sleep(SCRYFALL_DELAY);
  }

  console.log(`  Fetched ${fetched} new cards. Cache total: ${Object.keys(merged).length}`);
  return { generated: new Date().toISOString(), count: Object.keys(merged).length, cards: merged };
}

// ---------------------------------------------------------------------------
// Step 4 — Fetch EDHRec inclusion data
// ---------------------------------------------------------------------------

function edhrecSlug(name) {
  return name.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, '-');
}

async function fetchEdhrecCard(name) {
  const url = `https://json.edhrec.com/pages/cards/${edhrecSlug(name)}.json`;
  try {
    const res = await get(url);
    if (res.status !== 200) return null;
    const json = parseJson(res.body, `EDHRec ${name}`);
    const card = json?.container?.json_dict?.card ?? json?.card ?? null;
    if (!card) return null;
    const num = card.num_decks ?? null;
    const potential = card.potential_decks ?? null;
    if (num == null || potential == null || potential === 0) return null;
    return { numDecks: num, potentialDecks: potential };
  } catch {
    return null;
  }
}

async function fetchAllEdhrec(cards) {
  console.log('\n=== Step 4: Fetching EDHRec inclusion data ===');
  const names = Object.keys(cards);
  console.log(`  ${names.length} cards, ${EDHREC_CONCURRENCY} concurrent workers`);

  const queue = [...names];
  let done = 0;
  let found = 0;

  async function worker() {
    while (queue.length > 0) {
      const name = queue.shift();
      const result = await fetchEdhrecCard(name);
      cards[name].edhrec = result;
      if (result) found++;
      done++;
      if (done % 200 === 0 || done === names.length) {
        process.stdout.write(`\r  ${done}/${names.length} fetched, ${found} with data…`);
      }
    }
  }

  await Promise.all(Array.from({ length: EDHREC_CONCURRENCY }, worker));
  process.stdout.write('\n');
  console.log(`  Done. ${found}/${names.length} cards have EDHRec data.`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

// Convert flat [{better, worse}] pairs to grouped [[better, ...worse]] format
// that index.html expects: for (const [better, ...worse] of pairsData)
function groupPairs(flatPairs) {
  const groups = new Map();
  for (const { better, worse } of flatPairs) {
    if (!groups.has(better)) groups.set(better, [better]);
    groups.get(better).push(worse);
  }
  return [...groups.values()];
}

// Remove pairs where either card is not legal in Commander, then prune orphaned
// cache entries. Returns { legalPairs, cards }.
function filterCommander(flatPairs, cards) {
  console.log('\n=== Step 3: Filtering by Commander legality ===');

  let notLegal = 0;
  let notFound = 0;
  const legalPairs = flatPairs.filter(({ better, worse }) => {
    for (const name of [better, worse]) {
      const c = cards[name];
      if (!c) { notFound++; return false; }
      if (c.legalities?.commander !== 'legal') { notLegal++; return false; }
    }
    return true;
  });

  const removed = flatPairs.length - legalPairs.length;
  console.log(`  Pairs removed : ${removed} (${notLegal} not legal, ${notFound} not found in cache)`);

  // Prune cards no longer referenced by any pair
  const referenced = new Set();
  for (const { better, worse } of legalPairs) {
    referenced.add(better);
    referenced.add(worse);
  }
  const prunedCards = Object.fromEntries(
    Object.entries(cards).filter(([name]) => referenced.has(name))
  );
  console.log(`  Cards removed : ${Object.keys(cards).length - Object.keys(prunedCards).length} (no longer in any pair)`);
  console.log(`  Remaining     : ${legalPairs.length} pairs, ${Object.keys(prunedCards).length} cards`);

  return { legalPairs, cards: prunedCards };
}

async function main() {
  // Step 1: fetch all pairs from Tagger
  const flatPairs = await fetchAllPairs();

  // Step 2: update cache with any new cards
  const existingCache = loadJson(CACHE_PATH, {});
  const updatedCache  = await updateCache(flatPairs, existingCache);

  // Step 3: filter to Commander-legal pairs and prune orphaned cache entries
  const { legalPairs, cards: legalCards } = filterCommander(flatPairs, updatedCache.cards);

  // Step 4: fetch EDHRec inclusion data for all cards
  await fetchAllEdhrec(legalCards);

  const finalCache = { generated: new Date().toISOString(), count: Object.keys(legalCards).length, cards: legalCards };
  const groupedPairs = groupPairs(legalPairs);

  writeJson(PAIRS_TMP, groupedPairs);
  writeJson(CACHE_TMP, finalCache);
  console.log(`\n  Wrote ${groupedPairs.length} groups (${legalPairs.length} pairs) to ${path.basename(PAIRS_TMP)}`);
  console.log(`  Wrote ${finalCache.count} entries to ${path.basename(CACHE_TMP)}`);

  // Atomic replace — only reached if all steps succeeded
  fs.renameSync(PAIRS_TMP, PAIRS_PATH);
  fs.renameSync(CACHE_TMP, CACHE_PATH);
  console.log('\n✓ card-pairs.json and card-cache.json updated successfully.');
}

main().catch(err => {
  for (const tmp of [PAIRS_TMP, CACHE_TMP]) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
  console.error(`\nERROR: ${err.message}`);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
