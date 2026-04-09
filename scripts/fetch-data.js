#!/usr/bin/env node
/**
 * Fetches FTI 2023 and WFF 2025 brand scores from WikiRate's open API
 * and writes them to data/fti_2023.json and data/wff_2025.json.
 *
 * Setup:
 *   1. Register for a free account at https://wikirate.org
 *   2. Go to your profile settings and generate an API token
 *   3. Run: WIKIRATE_API_KEY=your_token node scripts/fetch-data.js
 */

import { writeFile, mkdir } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');

const API_KEY = process.env.WIKIRATE_API_KEY;
if (!API_KEY) {
  console.error('Error: WIKIRATE_API_KEY environment variable is not set.');
  console.error('Register at https://wikirate.org to get a free API token.');
  process.exit(1);
}

// The parent/descendant metric aggregates all yearly editions.
// It returns the most recent score per brand across all FTI research years,
// and includes sub-brands (Hollister, Pull & Bear, Free People, etc.) that the
// curated top-200 explicit editions don't cover separately.
const METRICS = {
  fti_current: 'Fashion_Revolution+Fashion_Transparency_Index',
};

async function fetchAllAnswers(metricSlug) {
  const results = [];
  const pageSize = 200;
  let offset = 0;

  while (true) {
    const url = `https://wikirate.org/${metricSlug}+Answer.json?api_key=${API_KEY}&limit=${pageSize}&offset=${offset}`;
    console.log(`  Fetching offset ${offset}...`);

    const res = await fetch(url, {
      headers: { 'User-Agent': 'eco-alternatives-etl/1.0' },
    });

    if (!res.ok) {
      throw new Error(`WikiRate API error ${res.status}: ${await res.text()}`);
    }

    const data = await res.json();
    const items = data.items ?? data ?? [];

    if (!Array.isArray(items) || items.length === 0) break;

    for (const item of items) {
      // WikiRate answer schema: { id, company, year, value, ... }
      // Value may be a string like "72" or a number
      const raw = parseFloat(item.value);
      if (!isNaN(raw) && item.company) {
        results.push({ company: item.company, year: item.year, value: raw });
      }
    }

    if (items.length < pageSize) break;
    offset += pageSize;
    // Polite delay between pages
    await new Promise(r => setTimeout(r, 300));
  }

  return results;
}

async function run() {
  await mkdir(DATA_DIR, { recursive: true });

  for (const [key, slug] of Object.entries(METRICS)) {
    console.log(`\nFetching ${key} (${slug})...`);
    try {
      const answers = await fetchAllAnswers(slug);
      console.log(`  Got ${answers.length} brand scores.`);
      const outPath = join(DATA_DIR, `${key}.json`);
      await writeFile(outPath, JSON.stringify(answers, null, 2));
      console.log(`  Saved to ${outPath}`);
    } catch (err) {
      console.error(`  Failed: ${err.message}`);
    }
  }

  console.log(`\nDone. Run 'node scripts/seed-kv.js' to push scores to KV.`);
}

run();
