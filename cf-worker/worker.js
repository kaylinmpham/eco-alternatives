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
// SerpApi helpers — Google Lens (visual) + Google Shopping (name fallback)
// Swap in eBay Browse API helpers once eBay developer access is available.
// ---------------------------------------------------------------------------

const SERPAPI_URL = 'https://serpapi.com/search.json';

// Resale/secondhand platforms — sort these to the top of results.
const RESALE_DOMAINS = [
  'ebay.com', 'poshmark.com', 'depop.com', 'therealreal.com',
  'thredup.com', 'mercari.com', 'vestiairecollective.com', 'vinted.com',
];

function isResale(url) {
  const lower = (url || '').toLowerCase();
  return RESALE_DOMAINS.some(d => lower.includes(d));
}

function extractPlatform(sourceOrUrl) {
  const s = (sourceOrUrl || '').toLowerCase();
  if (s.includes('ebay'))       return 'eBay';
  if (s.includes('poshmark'))   return 'Poshmark';
  if (s.includes('depop'))      return 'Depop';
  if (s.includes('therealreal')) return 'TheRealReal';
  if (s.includes('thredup'))    return 'ThredUp';
  if (s.includes('mercari'))    return 'Mercari';
  if (s.includes('vestiaire'))  return 'Vestiaire';
  if (s.includes('vinted'))     return 'Vinted';
  try {
    return new URL(s.startsWith('http') ? s : `https://${s}`).hostname.replace(/^www\./, '');
  } catch {
    return 'Shop';
  }
}

function normaliseVisualMatches(items) {
  const sorted = [...(items || [])].sort((a, b) => isResale(b.link) - isResale(a.link));
  return sorted.slice(0, 8).map((item, i) => ({
    id: i + 1,
    name: item.title || 'Similar item',
    price: item.price?.value || (typeof item.price === 'string' ? item.price : '') || '',
    platform: extractPlatform(item.source || item.link),
    image: item.thumbnail || null,
    url: item.link,
  }));
}

function normaliseShoppingResults(items) {
  const sorted = [...(items || [])].sort((a, b) => isResale(b.link) - isResale(a.link));
  return sorted.slice(0, 8).map((item, i) => ({
    id: i + 1,
    name: item.title || 'Similar item',
    price: item.price || '',
    platform: extractPlatform(item.source || item.link),
    image: item.thumbnail || null,
    url: item.link,
  }));
}

// Wrap a fetch with an explicit timeout so one slow SerpApi call
// can't block the entire CF Worker response indefinitely.
async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

async function searchByImage(imageUrl, apiKey) {
  const params = new URLSearchParams({
    engine: 'google_lens',
    url: imageUrl,
    api_key: apiKey,
    hl: 'en',
  });
  try {
    const res = await fetchWithTimeout(`${SERPAPI_URL}?${params}`, 9000);
    if (!res.ok) return null;
    const data = await res.json();
    const items = normaliseVisualMatches(data.visual_matches);
    return items.length ? items : null;
  } catch {
    return null;
  }
}

async function searchByName(query, apiKey) {
  const params = new URLSearchParams({
    engine: 'google_shopping',
    q: `${query} used secondhand`,
    api_key: apiKey,
    num: '10',
    hl: 'en',
    gl: 'us',
  });
  try {
    const res = await fetchWithTimeout(`${SERPAPI_URL}?${params}`, 9000);
    if (!res.ok) return null;
    const data = await res.json();
    return normaliseShoppingResults(data.shopping_results || []);
  } catch {
    return null;
  }
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

      const { imageUrl, query } = body;
      if (!imageUrl && !query) {
        return new Response(
          JSON.stringify({ error: 'imageUrl or query required' }),
          { status: 400, headers: CORS_HEADERS },
        );
      }

      if (!env.SERPAPI_KEY) {
        return new Response(
          JSON.stringify({ error: 'search API not configured' }),
          { status: 503, headers: CORS_HEADERS },
        );
      }

      // Run image search and name search in parallel so total latency =
      // max(image_time, name_time) rather than their sum.
      const [imageResults, nameResults] = await Promise.all([
        imageUrl ? searchByImage(imageUrl, env.SERPAPI_KEY) : Promise.resolve(null),
        query    ? searchByName(query,    env.SERPAPI_KEY) : Promise.resolve(null),
      ]);

      // Prefer image results (visually similar) if we got enough of them;
      // otherwise fall back to name results.
      const alternatives = (imageResults && imageResults.length >= 4)
        ? imageResults
        : (nameResults && nameResults.length ? nameResults : imageResults);

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
