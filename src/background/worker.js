const SCORE_API_URL = "https://eco-alternatives-score.kaylinpham.workers.dev";

// Tracks the active fetch ID per tab. When a new product is detected or the
// tab navigates away, the ID changes so any in-flight fetch knows to discard
// its result instead of overwriting the current panel state.
const tabFetchId = new Map();

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

async function fetchScoreFromApi(brand) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(
      `${SCORE_API_URL}/score?brand=${encodeURIComponent(brand)}`,
      { signal: controller.signal },
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
  if (
    product.retailer &&
    product.retailer.toLowerCase() !== brand.toLowerCase()
  ) {
    const retailerResult = await fetchScoreFromApi(product.retailer);
    if (retailerResult) {
      // Brand has no data — surface the retailer as the primary scored entity.
      return {
        score: null,
        retailerName: product.retailer,
        retailerScore: retailerResult.score,
        retailerSource: retailerResult.source,
        retailerIsPrimary: true,
      };
    }
  }

  return { score: null };
}

async function fetchEbayAlternatives(product) {
  const query = (product.name || product.brand || "")
    .split(" ")
    .slice(0, 6)
    .join(" ");

  // Read the user's saved size preferences (set via the side-panel settings).
  const { sizes = [] } = await chrome.storage.local.get("sizes");

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    const res = await fetch(`${SCORE_API_URL}/ebay-search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        imageUrl: product.image || null,
        query: query || null,
        sizes: sizes.length ? sizes : undefined,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) return [];
    const data = await res.json();
    return data.alternatives ?? [];
  } catch {
    return [];
  }
}

async function handleProductDetected(product, tabId) {
  const fetchId = Date.now();
  tabFetchId.set(tabId, fetchId);

  // Store a loading marker immediately so the panel shows a loading state
  // if it opens while the fetch is still running.
  const brand = product.brand || product.name || null;
  await chrome.storage.session.set({
    [`product_${tabId}`]: { loading: true, brand },
  });

  // Notify the panel right away if it's already open.
  chrome.runtime
    .sendMessage({ type: "SHOW_LOADING_STATE", brand })
    .catch(() => {});

  // Run score lookup and eBay search in parallel.
  const [scoreData, alternatives] = await Promise.all([
    resolveScore(product),
    fetchEbayAlternatives(product),
  ]);

  // If the tab navigated away (CLEAR_PRODUCT deleted the fetch ID) or a newer
  // product was detected on the same tab, discard this stale result.
  if (tabFetchId.get(tabId) !== fetchId) return;

  const payload = { product, scoreData, alternatives };
  await chrome.storage.session.set({ [`product_${tabId}`]: payload });

  // The tab may have been closed or navigated away during the async fetch.
  try {
    chrome.action.setBadgeText({ text: "●", tabId });
  } catch {}
  try {
    chrome.action.setBadgeBackgroundColor({ color: "#16a34a", tabId });
  } catch {}

  chrome.runtime
    .sendMessage({ type: "PRODUCT_DATA", ...payload })
    .catch(() => {});
}

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const data = await chrome.storage.session.get(`product_${tabId}`);
  const payload = data[`product_${tabId}`] || null;
  let message;
  if (!payload) {
    message = { type: "SHOW_WAITING_STATE" };
  } else if (payload.loading) {
    message = { type: "SHOW_LOADING_STATE", brand: payload.brand };
  } else {
    message = { type: "PRODUCT_DATA", ...payload };
  }
  chrome.runtime.sendMessage(message).catch(() => {});
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "PRODUCT_DETECTED") {
    handleProductDetected(message.product, sender.tab.id);
  }

  if (message.type === "CLEAR_PRODUCT") {
    const tabId = sender.tab?.id;
    if (tabId) {
      tabFetchId.delete(tabId); // Invalidate any in-flight fetch for this tab
      chrome.storage.session.remove(`product_${tabId}`);
      chrome.action.setBadgeText({ text: "", tabId });
    }
    chrome.runtime.sendMessage({ type: "SHOW_WAITING_STATE" }).catch(() => {});
  }

  if (message.type === "GET_CURRENT_PRODUCT") {
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      const tabId = tabs[0]?.id;
      const data = await chrome.storage.session.get(`product_${tabId}`);
      const payload = data[`product_${tabId}`] || null;

      if (!payload && tabId) {
        // Nudge the content script to re-detect. Falls back to re-injecting
        // the scripts when the existing content script is orphaned (e.g. after
        // the extension reloads while the tab is already open).
        chrome.tabs.sendMessage(tabId, { type: "REDETECT" }).catch(() => {
          chrome.scripting
            .executeScript({
              target: { tabId },
              files: ["src/content/detector.js", "src/content/index.js"],
            })
            .catch(() => {});
        });
      }

      // Returns the full product payload, a loading marker ({ loading, brand }),
      // or null (no product detected on this page).
      sendResponse(payload);
    });
    return true;
  }
});
