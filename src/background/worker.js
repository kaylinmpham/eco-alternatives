const SCORE_API_URL = 'https://eco-alternatives-score.kaylinpham.workers.dev';

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

async function fetchScoreFromApi(brand) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(
      `${SCORE_API_URL}/score?brand=${encodeURIComponent(brand)}`,
      { signal: controller.signal }
    );
    clearTimeout(timeout);
    if (!res.ok) return null;
    const data = await res.json();
    return data.score !== null ? data : null;
  } catch {
    return null;
  }
}

async function resolveScore(product) {
  const brand = product.brand || product.name;
  if (!brand) return { score: null };

  const apiResult = await fetchScoreFromApi(brand);
  if (apiResult) return apiResult;

  // Brand has no score — check if it's sold through a rated retailer
  // so we can surface that context without conflating the two.
  if (product.retailer && product.retailer.toLowerCase() !== brand.toLowerCase()) {
    const retailerResult = await fetchScoreFromApi(product.retailer);
    if (retailerResult) {
      return { score: null, retailerName: product.retailer, retailerScore: retailerResult.score };
    }
  }

  return { score: null };
}

// Called when the eBay API is unavailable; returns search-link cards for
// secondhand platforms so the panel is never completely empty.
function buildFallbackAlternatives(product) {
  const query = encodeURIComponent(product.name || product.brand || '');
  const shortName = (product.name || 'Item').split(' ').slice(0, 4).join(' ');

  return [
    {
      id: 1,
      name: shortName,
      price: '',
      platform: 'eBay',
      image: 'https://placehold.co/200x200/e5e7eb/6b7280?text=eBay',
      url: `https://www.ebay.com/sch/i.html?_nkw=${query}&LH_ItemCondition=3000%7C4000%7C1000`
    },
    {
      id: 2,
      name: shortName,
      price: '',
      platform: 'Depop',
      image: 'https://placehold.co/200x200/e5e7eb/6b7280?text=Depop',
      url: `https://www.depop.com/search/?q=${query}`
    },
    {
      id: 3,
      name: shortName,
      price: '',
      platform: 'Poshmark',
      image: 'https://placehold.co/200x200/e5e7eb/6b7280?text=Poshmark',
      url: `https://poshmark.com/search?query=${query}`
    },
    {
      id: 4,
      name: shortName,
      price: '',
      platform: 'TheRealReal',
      image: 'https://placehold.co/200x200/e5e7eb/6b7280?text=TRR',
      url: `https://www.therealreal.com/search?q=${query}`
    }
  ];
}

async function fetchEbayAlternatives(product) {
  const query = (product.name || product.brand || '').split(' ').slice(0, 6).join(' ');

  // Read the user's saved size preferences (set via the side-panel settings).
  const { sizes = [] } = await chrome.storage.local.get('sizes');

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    const res = await fetch(`${SCORE_API_URL}/ebay-search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        imageUrl: product.image || null,
        query: query || null,
        sizes: sizes.length ? sizes : undefined,
      }),
      signal: controller.signal
    });
    clearTimeout(timeout);
    if (!res.ok) return buildFallbackAlternatives(product);
    const data = await res.json();
    return data.alternatives?.length ? data.alternatives : buildFallbackAlternatives(product);
  } catch {
    return buildFallbackAlternatives(product);
  }
}

async function handleProductDetected(product, tabId) {
  const scoreData = await resolveScore(product);
  const alternatives = await fetchEbayAlternatives(product);

  const payload = { product, scoreData, alternatives };
  await chrome.storage.session.set({ [`product_${tabId}`]: payload });

  // The tab may have been closed or navigated away during the async fetch.
  try { chrome.action.setBadgeText({ text: '●', tabId }); } catch {}
  try { chrome.action.setBadgeBackgroundColor({ color: '#16a34a', tabId }); } catch {}

  chrome.runtime.sendMessage({ type: 'PRODUCT_DATA', ...payload }).catch(() => {});
}

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const data = await chrome.storage.session.get(`product_${tabId}`);
  const payload = data[`product_${tabId}`] || null;
  const message = payload
    ? { type: 'PRODUCT_DATA', ...payload }
    : { type: 'SHOW_WAITING_STATE' };
  chrome.runtime.sendMessage(message).catch(() => {});
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'PRODUCT_DETECTED') {
    handleProductDetected(message.product, sender.tab.id);
  }

  if (message.type === 'CLEAR_PRODUCT') {
    const tabId = sender.tab?.id;
    if (tabId) {
      chrome.storage.session.remove(`product_${tabId}`);
      chrome.action.setBadgeText({ text: '', tabId });
    }
    chrome.runtime.sendMessage({ type: 'SHOW_WAITING_STATE' }).catch(() => {});
  }

  if (message.type === 'GET_CURRENT_PRODUCT') {
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      const tabId = tabs[0]?.id;
      const data = await chrome.storage.session.get(`product_${tabId}`);
      sendResponse(data[`product_${tabId}`] || null);
    });
    return true;
  }
});
