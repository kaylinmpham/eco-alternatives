/**
 * Cloudflare Worker — eco-alternatives ESG scoring endpoint
 *
 * Score lookup chain (in order):
 *   1. KV store — FTI / WFF data seeded at deploy time
 *   2. Good On You — live fetch from directory.goodonyou.eco, cached in KV 30 days
 *   3. Claude AI estimate — cached in KV 90 days; max 50 new calls/day
 *
 * Data sources:
 *   - Fashion Transparency Index (Fashion Revolution / WikiRate, CC BY-NC 4.0)
 *   - Good On You brand ratings (goodonyou.eco)
 *   - Claude Haiku AI estimate (Anthropic)
 *
 * Secrets required: ANTHROPIC_API_KEY (wrangler secret put ANTHROPIC_API_KEY)
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

const SCORE_LABELS = {
  5: 'Great — industry-leading sustainability across all areas',
  4: 'Good — meaningful commitments across ethics, labour & environment',
  3: "It's a start — some sustainability efforts, room to improve",
  2: 'Poor — below average practices with limited transparency',
  1: 'We avoid — poor transparency and sustainability record',
};

// ---------------------------------------------------------------------------
// Good On You lookup — fetches goodonyou.eco on cache miss, caches 30 days
// ---------------------------------------------------------------------------

// Convert a brand display name to the slug format used by Good On You URLs.
// e.g. "Free People" → "free-people", "Abercrombie & Fitch" → "abercrombie-and-fitch"
function brandToGoySlug(brandName) {
  return brandName
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/['']/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

async function goyLookup(brandParam, env) {
  const cacheKey = `goy_${normaliseBrand(brandParam)}`;

  const cached = await env.SCORES_KV.get(cacheKey, 'json');
  // null means the key doesn't exist yet; {score:null} means we cached a miss
  if (cached !== null) return cached.score != null ? cached : null;

  const slug = brandToGoySlug(brandParam);
  if (!slug || slug.length < 2) return null;

  try {
    const res = await fetch(`https://directory.goodonyou.eco/brand/${slug}`, {
      headers: { 'User-Agent': 'mint-condition-extension/1.0' },
    });

    if (!res.ok) {
      await env.SCORES_KV.put(cacheKey, JSON.stringify({ score: null }), { expirationTtl: 604800 }); // 7 days
      return null;
    }

    const html = await res.text();
    // Matches "Rated : Good", "Rated: It's a start", etc.
    const m = html.match(/Rated\s*:?\s*(Great|Good|It[’']s a [Ss]tart|Not [Gg]ood [Ee]nough|We [Aa]void)/i);
    if (!m) {
      await env.SCORES_KV.put(cacheKey, JSON.stringify({ score: null }), { expirationTtl: 604800 });
      return null;
    }

    const ratingText = m[1].toLowerCase().replace(/[’']/g, "'");
    const GOY_SCORE_MAP = { 'great': 5, 'good': 4, "it's a start": 3, 'not good enough': 2, 'we avoid': 1 };
    const score = GOY_SCORE_MAP[ratingText];
    if (!score) {
      await env.SCORES_KV.put(cacheKey, JSON.stringify({ score: null }), { expirationTtl: 604800 });
      return null;
    }

    const payload = {
      score,
      label: SCORE_LABELS[score],
      source: 'goy',
      methodology: 'Good On You brand rating (goodonyou.eco). Independently assessed.',
      updatedAt: new Date().toISOString().slice(0, 10),
    };
    await env.SCORES_KV.put(cacheKey, JSON.stringify(payload), { expirationTtl: 2592000 }); // 30 days
    return payload;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Claude AI fallback — estimates score for brands not in KV or GOY
// ---------------------------------------------------------------------------

async function aiScoreLookup(brandParam, env) {
  if (!env.ANTHROPIC_API_KEY) return null;

  const normKey = normaliseBrand(brandParam);
  // Reject inputs that look like junk (too short/long, non-brand characters)
  if (normKey.length < 2 || normKey.length > 80) return null;
  if (!/^[a-z0-9\s-]+$/.test(normKey)) return null;

  const aiCacheKey = `ai_${normKey}`;
  const cached = await env.SCORES_KV.get(aiCacheKey, 'json');
  if (cached !== null) return cached.score != null ? cached : null;

  // Hard cap: max 50 new AI calls per day to prevent runaway costs
  const today = new Date().toISOString().slice(0, 10);
  const counterKey = `ai_calls_${today}`;
  const callCount = (await env.SCORES_KV.get(counterKey, 'json')) ?? 0;
  if (callCount >= 50) return null;

  let aiResult;
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 100,
        messages: [{
          role: 'user',
          content: `Rate the fashion brand "${brandParam}" on sustainability (1–5):\n1=We Avoid  2=Poor  3=Fair  4=Good  5=Great\n\nBase this on publicly known ethics, labour, and environmental practices.\nJSON only: {"score":1-5,"confidence":"high"|"medium"|"low"}\nNo reliable info about this brand: {"score":null,"confidence":"none"}`,
        }],
      }),
    });
    if (!res.ok) {
      console.error(`AI score API error for "${brandParam}": ${res.status} ${res.statusText}`);
      return null;
    }
    const data = await res.json();
    const raw = data.content?.[0]?.text?.trim() ?? '';
    // Extract JSON from the response even if the model wraps it in prose.
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    aiResult = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
  } catch (err) {
    console.error(`AI score lookup failed for "${brandParam}":`, err);
    return null;
  }

  if (!aiResult || typeof aiResult !== 'object') return null;

  // Increment daily counter whether we got a score or not
  await env.SCORES_KV.put(counterKey, JSON.stringify(callCount + 1), { expirationTtl: 86400 });

  const { score, confidence } = aiResult;

  if (score == null || confidence === 'none') {
    await env.SCORES_KV.put(aiCacheKey, JSON.stringify({ score: null }), { expirationTtl: 2592000 });
    return null;
  }

  const scoreInt = Math.round(score);
  if (scoreInt < 1 || scoreInt > 5) return null;

  const payload = {
    score: scoreInt,
    label: SCORE_LABELS[scoreInt],
    confidence,
    source: 'ai',
    methodology: 'Claude AI estimate based on publicly available brand information.',
    updatedAt: new Date().toISOString().slice(0, 10),
  };
  // Cache confident scores 90 days, low-confidence 30 days
  const ttl = confidence === 'low' ? 2592000 : 7776000;
  await env.SCORES_KV.put(aiCacheKey, JSON.stringify(payload), { expirationTtl: ttl });
  return payload;
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

  // Retry up to 3 times — CF → eBay OAuth connectivity is intermittently unreliable.
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetchWithTimeout(EBAY_TOKEN_URL, 6000, {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${credentials}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: `grant_type=client_credentials&scope=${encodeURIComponent(EBAY_SCOPE)}`,
      });

      if (res.ok) {
        const data = await res.json();
        await env.SCORES_KV.put(
          EBAY_TOKEN_KV,
          JSON.stringify({
            access_token: data.access_token,
            expires_at: Date.now() + data.expires_in * 1000,
          }),
        );
        return { token: data.access_token };
      }
    } catch {
      // timeout or network error — try again unless last attempt
    }

    if (attempt < 3) {
      await new Promise(r => setTimeout(r, 400));
    }
  }

  // All attempts failed — fall back to stale cached token if available.
  // Extend expires_at by 30 min so subsequent requests don't all retry immediately.
  if (cached) {
    await env.SCORES_KV.put(
      EBAY_TOKEN_KV,
      JSON.stringify({ ...cached, expires_at: Date.now() + 30 * 60 * 1000 }),
    );
    return { token: cached.access_token };
  }

  return { error: 'eBay token unavailable' };
}

function ebayHeaders(token, marketplaceId = 'EBAY_US') {
  return {
    'Authorization': `Bearer ${token}`,
    'X-EBAY-C-MARKETPLACE-ID': marketplaceId,
    'Content-Type': 'application/json',
  };
}

function normaliseEbayItems(items, marketplaceId = 'EBAY_US') {
  return (items || []).slice(0, 20).map((item, i) => {
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
  const params = new URLSearchParams({ q: query, limit: '20' });
  const aspectFilter = buildAspectFilter(sizes);
  if (aspectFilter) params.set('aspect_filter', aspectFilter);

  try {
    const res = await fetchWithTimeout(
      `${EBAY_BROWSE_BASE}/item_summary/search?${params}`,
      6000,
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
  const settled = await Promise.allSettled(
    SEARCH_MARKETS.map(mktId => ebaySearchByText(query, token, sizes, mktId)),
  );

  const perMarket = settled.map(r => (r.status === 'fulfilled' ? r.value : null));

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
        if (merged.length >= 20) break outer;
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
  // Runs every hour — proactively refreshes the eBay token before it expires.
  async scheduled(_event, env) {
    const cached = await env.SCORES_KV.get(EBAY_TOKEN_KV, 'json');
    if (cached) {
      // Mark as just-expired so getEbayToken attempts a refresh,
      // but keeps the stale token available as fallback if refresh fails.
      await env.SCORES_KV.put(EBAY_TOKEN_KV, JSON.stringify({ ...cached, expires_at: Date.now() - 1 }));
    }
    await getEbayToken(env);
  },

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

    // 1. FTI / WFF — seeded in KV at deploy time
    const kvResult = await kvLookup(brandParam, env);
    if (kvResult) return new Response(JSON.stringify(kvResult), { headers: CORS_HEADERS });

    // 2. Good On You — live fetch, cached in KV 30 days
    const goyResult = await goyLookup(brandParam, env);
    if (goyResult) return new Response(JSON.stringify(goyResult), { headers: CORS_HEADERS });

    // 3. Claude AI estimate — cached in KV 90 days, max 50 new calls/day
    const aiResult = await aiScoreLookup(brandParam, env);
    if (aiResult) return new Response(JSON.stringify(aiResult), { headers: CORS_HEADERS });

    return new Response(
      JSON.stringify({
        score: null,
        label: 'No sustainability data found for this brand',
        hint: 'We check FTI research, Good On You ratings, and AI estimates.',
      }),
      { headers: CORS_HEADERS }
    );
  },
};
