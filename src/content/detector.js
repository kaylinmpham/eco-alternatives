function detectProduct() {
  const fromJsonLd = detectFromJsonLd();
  if (fromJsonLd) return fromJsonLd;

  const fromOpenGraph = detectFromOpenGraph();
  if (fromOpenGraph) return fromOpenGraph;

  return detectFromDom();
}

// Resolve the best available product image from og:image or a DOM fallback.
// Sanitises protocol-relative URLs (//) that SerpApi can't use.
function resolveImage() {
  const ogMeta = document.querySelector('meta[property="og:image"]');
  const ogUrl = ogMeta?.getAttribute('content')?.trim();
  if (ogUrl) {
    return ogUrl.startsWith('//') ? `https:${ogUrl}` : ogUrl;
  }

  // DOM fallback for SPAs where og:image lags behind the title update
  const imgEl = document.querySelector(
    '[data-testid="product-image"] img, ' +
    '[data-auto-id="product-image"] img, ' +
    '.product-image__image, ' +
    'img[class*="product-image"], ' +
    'img[class*="ProductImage"]'
  );
  const src = imgEl?.src || imgEl?.getAttribute('data-src') || null;
  return src?.startsWith('http') ? src : null;
}

function detectFromOpenGraph() {
  const titleMeta = document.querySelector('meta[property="og:title"]');
  const rawName = titleMeta?.getAttribute('content')?.trim();
  if (!rawName) return null;

  const { brand, cleanName } = resolveBrand(rawName);

  return {
    name: cleanName,
    brand,
    image: resolveImage(),
    url: window.location.href
  };
}

// ---------------------------------------------------------------------------
// Brand extraction — two universal layers in descending confidence order
// ---------------------------------------------------------------------------

// Layer 1: og:site_name — a W3C standard meta explicitly set by sites to
// identify themselves. Single-brand retailers set this to their brand name
// (e.g. "H&M", "Zara", "ASOS"). More reliable than parsing the title.
function extractBrandFromSiteName() {
  const meta = document.querySelector('meta[property="og:site_name"]');
  return meta?.getAttribute('content')?.trim() || null;
}

// Layer 2: OG title suffix parsing.
// Many sites format titles as "Product Name | Brand Name" or "Product — Brand".
// Returns { brand, cleanName } so we can also strip the suffix from the product name.
function parseTitleForBrand(title) {
  if (!title) return null;

  // "Product | Brand" or "Product | Brand US"
  const pipeMatch = title.match(/\|\s*(.{2,50})\s*$/);
  if (pipeMatch) {
    const raw = pipeMatch[1].replace(/\s+(US|UK|AU|EU|CA|IN|DE|FR|NL|SE|NZ)$/i, '').trim();
    const cleanName = title.slice(0, title.lastIndexOf('|')).trim();
    return { brand: raw, cleanName };
  }

  // "Product – Brand" (en-dash) or "Product — Brand" (em-dash)
  const dashMatch = title.match(/[\u2013\u2014]\s*(.{2,50})\s*$/);
  if (dashMatch) {
    const raw = dashMatch[1].replace(/\s+(US|UK|AU|EU|CA|IN|DE|FR|NL|SE|NZ)$/i, '').trim();
    const cleanName = title.slice(0, title.search(/[\u2013\u2014]/)).trim();
    return { brand: raw, cleanName };
  }

  return null;
}

// Master brand resolver — returns { brand, cleanName }.
function resolveBrand(rawProductName) {
  // Layer 1: og:site_name (universal, explicitly set by the site)
  const siteName = extractBrandFromSiteName();
  if (siteName) {
    const parsed = parseTitleForBrand(rawProductName);
    return {
      brand: siteName,
      cleanName: parsed?.cleanName || rawProductName,
    };
  }

  // Layer 2: title suffix ("Product | Brand" or "Product — Brand")
  const parsed = parseTitleForBrand(rawProductName);
  if (parsed) return { brand: parsed.brand, cleanName: parsed.cleanName };

  // No brand signal found
  return { brand: null, cleanName: rawProductName };
}

function detectFromJsonLd() {
  const scripts = document.querySelectorAll('script[type="application/ld+json"]');

  for (const script of scripts) {
    try {
      const data = JSON.parse(script.textContent);
      const items = Array.isArray(data) ? data : [data];
      const product = items.find(item => item['@type'] === 'Product');

      if (product) {
        const rawBrand = typeof product.brand === 'string'
          ? product.brand
          : product.brand?.name || null;
        // If JSON-LD has no brand, fall through to our resolver
        const { brand, cleanName } = rawBrand
          ? { brand: rawBrand, cleanName: product.name || null }
          : resolveBrand(product.name || '');
        const imageRaw = product.image;
        let image = typeof imageRaw === 'string'
          ? imageRaw
          : Array.isArray(imageRaw) ? imageRaw[0]
          : imageRaw?.url || null;
        if (image?.startsWith('//')) image = `https:${image}`;
        return {
          name: cleanName,
          brand,
          image: image || resolveImage(),
          url: window.location.href
        };
      }
    } catch {
      continue;
    }
  }

  return null;
}

function detectFromDom() {
  const titleEl = document.querySelector(
    '#productTitle, ' +
    '[data-auto-id="pdp-product-title"], ' +
    '[data-auto-id="product-title"], ' +
    'h1[data-automation="product-title"], ' +
    'h1.product-name, ' +
    'h1[class*="product-title"], ' +
    'h1[class*="productTitle"]'
  );

  if (!titleEl) return null;

  const brandEl = document.querySelector(
    '#bylineInfo, ' +
    '[data-auto-id="product-brand"], ' +
    '[data-testid="brand-name"], ' +
    '.brand-name, ' +
    '[class*="brand-name"]'
  );

  const { brand, cleanName } = resolveBrand(titleEl.textContent.trim());
  const resolvedBrand = brandEl ? extractBrandFromByline(brandEl.textContent) : brand;

  return {
    name: cleanName,
    brand: resolvedBrand,
    image: resolveImage(),
    url: window.location.href
  };
}

function extractBrandFromByline(text) {
  const visitMatch = text.match(/^Visit the (.+?) Store/i);
  if (visitMatch) return visitMatch[1].trim();

  const brandMatch = text.match(/^Brand:\s*(.+)/i);
  if (brandMatch) return brandMatch[1].trim();

  return text.trim();
}
