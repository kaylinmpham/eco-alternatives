/**
 * Fetches a fresh eBay Application OAuth token locally and seeds it into
 * Cloudflare KV so the deployed worker can use it without needing to reach
 * eBay's auth endpoint from inside CF Workers.
 *
 * Usage:
 *   EBAY_CLIENT_ID=<id> EBAY_CLIENT_SECRET=<secret> node scripts/seed-ebay-token.js
 */

import { execSync } from 'child_process';

const { EBAY_CLIENT_ID, EBAY_CLIENT_SECRET } = process.env;

if (!EBAY_CLIENT_ID || !EBAY_CLIENT_SECRET) {
  console.error('Error: EBAY_CLIENT_ID and EBAY_CLIENT_SECRET env vars are required.');
  console.error('Usage: EBAY_CLIENT_ID=xxx EBAY_CLIENT_SECRET=yyy node scripts/seed-ebay-token.js');
  process.exit(1);
}

const EBAY_TOKEN_URL = 'https://api.ebay.com/identity/v1/oauth2/token';
const EBAY_SCOPE     = 'https://api.ebay.com/oauth/api_scope';
const KV_KEY         = 'ebay_token_cache';

console.log('Fetching eBay token...');

const credentials = Buffer.from(`${EBAY_CLIENT_ID}:${EBAY_CLIENT_SECRET}`).toString('base64');

const res = await fetch(EBAY_TOKEN_URL, {
  method: 'POST',
  headers: {
    'Authorization': `Basic ${credentials}`,
    'Content-Type': 'application/x-www-form-urlencoded',
  },
  body: `grant_type=client_credentials&scope=${encodeURIComponent(EBAY_SCOPE)}`,
});

if (!res.ok) {
  const text = await res.text();
  console.error(`eBay auth failed (${res.status}): ${text}`);
  process.exit(1);
}

const data = await res.json();
const payload = JSON.stringify({
  access_token: data.access_token,
  expires_at: Date.now() + data.expires_in * 1000,
});

console.log(`Got token. Expires in ${Math.round(data.expires_in / 3600)}h. Seeding KV...`);

// Write to Cloudflare KV via wrangler CLI — --remote targets the deployed KV namespace
execSync(
  `npx wrangler kv key put "${KV_KEY}" '${payload}' --binding=SCORES_KV --config=cf-worker/wrangler.toml --remote`,
  { stdio: 'inherit' }
);

console.log('Done. Token is live in KV.');
