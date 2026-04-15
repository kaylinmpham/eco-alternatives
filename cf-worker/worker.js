/**
 * Cloudflare Worker — eco-alternatives ESG scoring endpoint
 *
 * Serves brand sustainability scores from KV, populated by the ETL pipeline
 * in scripts/fetch-data.js + scripts/seed-kv.js.
 *
 * Data sources (via WikiRate open data API, CC BY-NC 4.0):
 *   - Fashion Transparency Index 2023 (250 brands, broad ethics/labour/environment)
 *   - What Fuels Fashion? 2025 (200 brands, climate & energy)
 *
 * Composite score: FTI 2023 × 0.6 + WFF 2025 × 0.4 → mapped to 1–5 stars.
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json',
};

// Normalise brand name the same way seed-kv.js does, so lookups are consistent.
function normaliseBrand(name) {
  return name
    .toLowerCase()
    .replace(/&/g, 'and')       // 'H&M' → 'handm', "Marks & Spencer" → 'marks and spencer'
    .replace(/'/g, '')          // "Levi's" → 'levis'
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// eBay Browse API helpers — image search + text search fallback
// ---------------------------------------------------------------------------

const EBAY_TOKEN_URL   = 'https://api.ebay.com/identity/v1/oauth2/token';
const EBAY_BROWSE_BASE = 'https://api.ebay.com/buy/browse/v1';
const EBAY_SCOPE       = 'https://api.ebay.com/oauth/api_scope';
const EBAY_TOKEN_KV    = 'ebay_token_cache';

// Markets to fan out text search to. Image search stays US-only (heavier call).
const SEARCH_MARKETS = ['EBAY_US', 'EBAY_GB', 'EBAY_DE'];

const MARKET_LABELS = {
  EBAY_US: 'eBay US',
  EBAY_GB: 'eBay UK',
  EBAY_DE: 'eBay DE',
};

const CURRENCY_SYMBOLS = {
  USD: '$', GBP: '\u00a3', EUR: '\u20ac', AUD: 'A$', CAD: 'C$',
};

// Fetch (or return cached) Application-level OAuth token, stored in KV
// so we don't re-authenticate on every request (token valid ~2 hours).
async function getEbayToken(env) {
  const cached = await env.SCORES_KV.get(EBAY_TOKEN_KV, 'json');
  if (cached && cached.expires_at > Date.now() + 60_000) {
    return { token: cached.access_token };
  }

  const credentials = btoa(`${env.EBAY_CLIENT_ID}:${env.EBAY_CLIENT_SECRET}`);
  const res = await fetch(EBAY_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: `grant_type=client_credentials&scope=${encodeURIComponent(EBAY_SCOPE)}`,
  });
  if (!res.ok) {
    const errText = await res.text();
    return { error: `eBay auth ${res.status}: ${errText}` };
  }

  const data = await res.json();
  await env.SCORES_KV.put(
    EBAY_TOKEN_KV,
    JSON.stringify({
      access_token: data.access_token,
      expires_at: Date.now() + data.expires_in * 1000,
    }),
    { expirationTtl: data.expires_in - 60 },
  );
  return { token: data.access_token };
}

function ebayHeaders(token, marketplaceId = 'EBAY_US') {
  return {
    'Authorization': `Bearer ${token}`,
    'X-EBAY-C-MARKETPLACE-ID': marketplaceId,
    'Content-Type': 'application/json',
  };
}

function normaliseEbayItems(items, marketplaceId = 'EBAY_US') {
  return (items || []).slice(0, 8).map((item, i) => {
    const currency = item.price?.currency || 'USD';
    const symbol = CURRENCY_SYMBOLS[currency] || (currency + '\u00a0');
    const price = item.price ? `${symbol}${parseFloat(item.price.value).toFixed(2)}` : '';
    return {
      id: i + 1,
      name: item.title || 'eBay listing',
      price,
      platform: MARKET_LABELS[marketplaceId] || 'eBay',
      condition: item.condition || '',
      image: item.image?.imageUrl || null,
      url: item.itemWebUrl || `https://www.ebay.com/itm/${item.itemId}`,
    };
  });
}

// Returns eBay aspect_filter string for size filtering, or null if no sizes given.
// Format: aspectName:Size,aspectValueName:S|M|L
function buildAspectFilter(sizes) {
  if (!sizes || sizes.length === 0) return null;
  return `aspectName:Size,aspectValueName:${sizes.join('|')}`;
}

// Wrap a fetch with an explicit timeout so one slow API call
// can't block the entire CF Worker response indefinitely.
async function fetchWithTimeout(url, timeoutMs, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

// Fetch a remote image and return its base64 representation for eBay's
// search_by_image endpoint, which requires raw image data (not a URL).
async function imageUrlToBase64(url) {
  try {
    // Basic SSRF guard: only allow http/https image URLs.
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;

    const res = await fetchWithTimeout(url, 8000);
    if (!res.ok) return null;
    const buffer = await res.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  } catch {
    return null;
  }
}

async function ebaySearchByImage(imageUrl, query, token, sizes) {
  const base64 = await imageUrlToBase64(imageUrl);
  if (!base64) return null;

  const params = new URLSearchParams({ limit: '20' });
  if (query) params.set('q', query);
  const aspectFilter = buildAspectFilter(sizes);
  if (aspectFilter) params.set('aspect_filter', aspectFilter);

  try {
    // Image search is US-only — it's a heavier call and we fan out text search instead.
    const res = await fetchWithTimeout(
      `${EBAY_BROWSE_BASE}/item_summary/search_by_image?${params}`,
      15000,
      { method: 'POST', headers: ebayHeaders(token, 'EBAY_US'), body: JSON.stringify({ image: base64 }) },
    );
    if (!res.ok) return null;
    const data = await res.json();
    const items = normaliseEbayItems(data.itemSummaries, 'EBAY_US');
    return items.length ? items : null;
  } catch {
    return null;
  }
}

async function ebaySearchByText(query, token, sizes, marketplaceId = 'EBAY_US') {
  const params = new URLSearchParams({ q: query, limit: '8' });
  const aspectFilter = buildAspectFilter(sizes);
  if (aspectFilter) params.set('aspect_filter', aspectFilter);

  try {
    const res = await fetchWithTimeout(
      `${EBAY_BROWSE_BASE}/item_summary/search?${params}`,
      10000,
      { headers: ebayHeaders(token, marketplaceId) },
    );
    if (!res.ok) return null;
    const data = await res.json();
    const items = normaliseEbayItems(data.itemSummaries, marketplaceId);
    return items.length ? items : null;
  } catch {
    return null;
  }
}

// Fan text search out to all SEARCH_MARKETS in parallel, merge + deduplicate,
// and return up to 8 results interleaved across markets (round-robin by index
// so no single market dominates the first slots).
async function ebaySearchMultiMarket(query, token, sizes) {
  const perMarket = await Promise.all(
    SEARCH_MARKETS.map(mktId => ebaySearchByText(query, token, sizes, mktId)),
  );

  // Round-robin interleave: take item 0 from each market, then item 1, etc.
  const seen = new Set();
  const merged = [];
  const maxLen = Math.max(...perMarket.map(r => r?.length || 0));
  outer: for (let i = 0; i < maxLen; i++) {
    for (const items of perMarket) {
      if (!items || i >= items.length) continue;
      const item = items[i];
      if (!seen.has(item.url)) {
        seen.add(item.url);
        merged.push(item);
        if (merged.length >= 8) break outer;
      }
    }
  }

  // Re-index ids after merge.
  merged.forEach((item, i) => { item.id = i + 1; });
  return merged.length ? merged : null;
}

// Strip common corporate suffixes before KV lookup.
// e.g. 'adidas ag' → 'adidas', 'nike inc' → 'nike'
const CORP_SUFFIX_RE = /\s+(inc|ag|se|plc|llc|ltd|sa|spa|bv|co|corp|group|holding|holdings|gmbh|nv|oy|ab|as|apsc)\.?$/;
function stripSuffix(name) {
  return name.replace(CORP_SUFFIX_RE, '').trim();
}

// Look up a brand in KV using progressive prefix reduction so we don't need
// a hand-maintained alias table. Tries the full normalised name first, then
// removes one word from the right on each iteration until a match is found.
// e.g. 'calvin klein jeans' → 'calvin klein jeans' (miss) → 'calvin klein' (hit)
//      'h&m us' normalises to 'hm us' → 'hm us' (miss) → 'hm' (hit)
async function kvLookup(brandParam, env) {
  const words = normaliseBrand(brandParam).split(' ').filter(Boolean);

  for (let len = words.length; len >= 1; len--) {
    const candidate = words.slice(0, len).join(' ');

    const result = await env.SCORES_KV.get(candidate, 'json');
    if (result) return result;

    const stripped = stripSuffix(candidate);
    if (stripped !== candidate) {
      const strippedResult = await env.SCORES_KV.get(stripped, 'json');
      if (strippedResult) return strippedResult;
    }
  }

  return null;
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    // ------------------------------------------------------------------
    // POST /ebay-search  { imageUrl?: string, query?: string }
    // Tries image search first; falls back to name search.
    // ------------------------------------------------------------------
    if (url.pathname === '/ebay-search') {
      if (request.method !== 'POST') {
        return new Response('Method not allowed', { status: 405, headers: CORS_HEADERS });
      }

      let body;
      try {
        body = await request.json();
      } catch {
        return new Response(
          JSON.stringify({ error: 'invalid JSON body' }),
          { status: 400, headers: CORS_HEADERS },
        );
      }

      const { imageUrl, query, sizes } = body;
      if (!imageUrl && !query) {
        return new Response(
          JSON.stringify({ error: 'imageUrl or query required' }),
          { status: 400, headers: CORS_HEADERS },
        );
      }

      if (!env.EBAY_CLIENT_ID || !env.EBAY_CLIENT_SECRET) {
        return new Response(
          JSON.stringify({ error: 'eBay API not configured' }),
          { status: 503, headers: CORS_HEADERS },
        );
      }

      const tokenResult = await getEbayToken(env);
      if (tokenResult.error) {
        return new Response(
          JSON.stringify({ error: 'eBay authentication failed' }),
          { status: 503, headers: CORS_HEADERS },
        );
      }
      const token = tokenResult.token;

      // Image search (US-only) and multi-market text search run in parallel.
      // Prefer image results when we get enough of them.
      const [imageResults, textResults] = await Promise.all([
        imageUrl ? ebaySearchByImage(imageUrl, query, token, sizes) : Promise.resolve(null),
        query    ? ebaySearchMultiMarket(query, token, sizes)        : Promise.resolve(null),
      ]);

      const alternatives = (imageResults && imageResults.length >= 4)
        ? imageResults
        : (textResults?.length ? textResults : imageResults);

      return new Response(
        JSON.stringify({ alternatives: alternatives || [] }),
        { headers: CORS_HEADERS },
      );
    }

    if (url.pathname !== '/score') {
      return new Response('Not found', { status: 404 });
    }

    const brandParam = url.searchParams.get('brand')?.trim();
    if (!brandParam) {
      return new Response(
        JSON.stringify({ error: 'brand parameter required' }),
        { status: 400, headers: CORS_HEADERS }
      );
    }

    const result = await kvLookup(brandParam, env);
    if (result) {
      return new Response(JSON.stringify(result), { headers: CORS_HEADERS });
    }

    // Not in database
    return new Response(
      JSON.stringify({
        score: null,
        label: 'No data found for this brand',
        hint: 'We cover ~300 major fashion brands scored by Fashion Revolution research.',
      }),
      { headers: CORS_HEADERS }
    );
  },
};
