let lastReportedUrl = '';
let lastReportedHadImage = false;

function tryDetectAndReport() {
  const currentUrl = window.location.href;
  const urlChanged = currentUrl !== lastReportedUrl;

  // Already reported this URL with an image — nothing left to do.
  if (!urlChanged && lastReportedHadImage) return;

  const product = detectProduct();

  if (!product || !product.name) {
    // URL changed but no product found (e.g. navigated to search results).
    // Clear stale panel data so the side panel doesn't show the old product.
    if (urlChanged) {
      lastReportedUrl = currentUrl;
      lastReportedHadImage = false;
      chrome.runtime.sendMessage({ type: 'CLEAR_PRODUCT' }).catch(() => {});
    }
    return;
  }

  lastReportedUrl = currentUrl;
  lastReportedHadImage = !!product.image;
  chrome.runtime.sendMessage({ type: 'PRODUCT_DETECTED', product });
}

new MutationObserver(() => {
  tryDetectAndReport();
}).observe(document.querySelector('title') || document.documentElement, {
  subtree: true,
  childList: true,
  characterData: true
});

tryDetectAndReport();

// Retry a couple of times for sites that render meta tags or the h1 via
// client-side JS after DOMContentLoaded (e.g. headless/SPA storefronts).
setTimeout(() => { if (!lastReportedHadImage) tryDetectAndReport(); }, 1500);
setTimeout(() => { if (!lastReportedHadImage) tryDetectAndReport(); }, 4000);
