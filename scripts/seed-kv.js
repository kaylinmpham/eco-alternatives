#!/usr/bin/env node
/**
 * Reads WikiRate data from data/fti_2023.json and data/wff_2025.json,
 * computes a composite 1–5 ethics/sustainability score for each brand,
 * and pushes every entry to Cloudflare KV via `wrangler kv key put`.
 *
 * Run after fetch-data.js:
 *   node scripts/seed-kv.js
 *
 * Score methodology:
 *   - Source: Fashion Revolution Fashion Transparency Index (all editions).
 *     WikiRate's descendant metric returns the most recent available score per
 *     brand on a 0–10 scale (= 0–100%). Covers 300+ brands including sub-brands.
 *   - 0–10 score maps to 1–5 stars:
 *       < 2.0  → 1  (We avoid)
 *       2.0–3.9 → 2  (Not good enough)
 *       3.9–5.5 → 3  (It's a start)
 *       5.5–7.2 → 4  (Good)
 *       ≥ 7.2  → 5  (Great)
 *
 * Data license:
 *   © Fashion Revolution, CC BY-NC 4.0
 *   https://creativecommons.org/licenses/by-nc/4.0/
 */

import { readFile, access } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const KV_NAMESPACE = 'SCORES_KV';

// ─── Score normalisation ──────────────────────────────────────────────────────

// FTI scores are on a 0–10 scale (WikiRate normalised)
function rawToStar(score) {
  if (score < 2.0) return 1;
  if (score < 3.9) return 2;
  if (score < 5.5) return 3;
  if (score < 7.2) return 4;
  return 5;
}

function starLabel(score) {
  switch (score) {
    case 5: return 'Great — strong transparency on ethics and climate';
    case 4: return 'Good — meaningful disclosure and positive steps';
    case 3: return "It's a start — some transparency, room to improve";
    case 2: return 'Not good enough — limited disclosure';
    default: return 'We avoid — poor transparency record';
  }
}

// ─── Brand name normalisation ────────────────────────────────────────────────

function normalise(name) {
  return name
    .toLowerCase()
    .replace(/&/g, 'and')       // 'H&M' → 'handm', "Marks & Spencer" → 'marks and spencer'
    .replace(/'/g, '')          // "Levi's" → 'levis'
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// WikiRate stores brands under their parent company name (e.g. "Inditex SA"
// rather than "Zara"). Map parent companies to the consumer brand name the user
// will encounter on product pages.
const PARENT_TO_CONSUMER = {
  'inditex':          'zara',
  'inditex sa':       'zara',
  'fast retailing':   'uniqlo',
  'pvh corp':         'calvin klein',
  'pvh':              'calvin klein',
  'abercrombie fitch':'abercrombie & fitch',
  'tapestry':         'coach',
  'capri holdings':   'michael kors',
  'vf corporation':   'vans',
  'kontoor brands':   'wranglerlevis',
  'hanesbrands':      'hanes',
  'oxford industries':'tommy hilfiger',
  'kontoor':          'wrangler',
  'the gap':          'gap',
  'gap inc':          'gap',
  'levi strauss':     'levis',
  'levi strauss co':  'levis',
  'marks and spencer group plc': 'marks and spencer',
  'hennes mauritz':   'hm',
  'h m':              'hm',
  'hugo boss ag':     'hugo boss',
  'kering':           'gucci',
};

function consumerName(raw) {
  const norm = normalise(raw);
  return PARENT_TO_CONSUMER[norm] ?? norm;
}

// Strip common corporate suffixes to create a short-form alias.
// e.g. 'nike inc' → 'nike', 'adidas ag' → 'adidas'
const CORP_SUFFIXES = /\s+(inc|ag|se|plc|llc|ltd|sa|spa|bv|co|corp|group|holding|holdings|gmbh|nv|oy|ab|as|apsc)(\.?)$/;
function stripSuffix(name) {
  return name.replace(CORP_SUFFIXES, '').trim();
}

// ─── Load datasets ────────────────────────────────────────────────────────────

async function loadJson(filename) {
  const filePath = join(DATA_DIR, filename);
  try {
    await access(filePath);
    const raw = await readFile(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// ─── KV push ─────────────────────────────────────────────────────────────────

function kvPut(key, value) {
  const json = JSON.stringify(value);
  const escaped = json.replace(/'/g, "'\\''");
  // TTL: 90 days (scores are stable within a research year)
  execSync(
    `wrangler kv key put --remote --binding=${KV_NAMESPACE} '${key}' '${escaped}' --ttl=7776000`,
    { cwd: join(__dirname, '..', 'cf-worker'), stdio: 'pipe' }
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function run() {
  const ftiData = await loadJson('fti_current.json');

  if (!ftiData) {
    console.error('No data file found at data/fti_current.json.');
    console.error("Run 'node scripts/fetch-data.js' first (requires WIKIRATE_API_KEY).");
    process.exit(1);
  }

  // Index by normalised consumer-facing brand name, keeping highest-value entry per brand
  const brandMap = new Map();
  for (const { company, value, year } of ftiData) {
    const key = consumerName(company);
    const existing = brandMap.get(key);
    if (!existing || value > existing.value) {
      brandMap.set(key, { value, companyName: company, year });
    }
  }

  console.log(`Processing ${brandMap.size} unique brands...`);

  let pushed = 0;
  let skipped = 0;

  for (const [brand, { value, companyName, year }] of brandMap) {
    const score = rawToStar(value);
    const payload = {
      score,
      label: starLabel(score),
      rawScore: Math.round(value * 10) / 10,
      dataYear: year,
      methodology: 'Fashion Transparency Index (Fashion Revolution / WikiRate). Score 0–10 → 1–5 stars. CC BY-NC 4.0.',
      updatedAt: new Date().toISOString().slice(0, 10),
    };

    try {
      kvPut(brand, payload);

      // 1. Alias: raw company name (e.g. 'nike inc')
      const rawKey = normalise(companyName);
      if (rawKey !== brand) kvPut(rawKey, payload);

      // 2. Alias: suffix-stripped short form (e.g. 'nike')
      const shortKey = stripSuffix(rawKey);
      if (shortKey !== brand && shortKey !== rawKey) kvPut(shortKey, payload);

      pushed++;
      if (pushed % 25 === 0) process.stdout.write(`  ${pushed} pushed...\r`);
    } catch (err) {
      console.error(`  Failed to push "${brand}": ${err.message}`);
      skipped++;
    }
  }

  console.log(`\nDone. Pushed ${pushed} brands, skipped ${skipped}.`);
}

run();
