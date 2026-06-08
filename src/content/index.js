let lastReportedUrl = '';
let lastReportedHadImage = false;
let lastReportedImageUrl = '';

function isContextValid() {
  try { return !!chrome.runtime?.id; } catch { return false; }
}

function sendMessage(payload) {
  try {
    chrome.runtime.sendMessage(payload).catch(() => {});
  } catch {
    observer.disconnect();
  }
}

function tryDetectAndReport() {
  if (!isContextValid()) { observer.disconnect(); return; }

  const currentUrl = window.location.href;
  const urlChanged = currentUrl !== lastReportedUrl;

  const product = detectProduct();

  if (!product || !product.name) {
    if (urlChanged) {
      lastReportedUrl = currentUrl;
      lastReportedHadImage = false;
      lastReportedImageUrl = '';
      sendMessage({ type: 'CLEAR_PRODUCT' });
    }
    return;
  }

  const imageChanged = !!product.image && product.image !== lastReportedImageUrl;

  // Skip if nothing meaningful changed — URL, image, or first-time detection
  if (!urlChanged && !imageChanged && lastReportedHadImage) return;

  lastReportedUrl = currentUrl;
  lastReportedHadImage = !!product.image;
  if (product.image) lastReportedImageUrl = product.image;

  sendMessage({ type: 'PRODUCT_DETECTED', product });
}

// Debounce observer-triggered detection so rapid DOM mutations during
// image/variant loading don't fire multiple redundant searches.
let _mutationTimer = null;
const observer = new MutationObserver(() => {
  clearTimeout(_mutationTimer);
  _mutationTimer = setTimeout(tryDetectAndReport, 350);
});
observer.observe(document.querySelector('title') || document.documentElement, {
  subtree: true,
  childList: true,
  characterData: true
});

// Respond to a panel-open nudge from the background worker.
// Resets image tracking so detection always re-fires even on a page the
// content script already reported, covering the case where the service
// worker was idle when the panel opened.
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'REDETECT') {
    lastReportedHadImage = false;
    lastReportedImageUrl = '';
    tryDetectAndReport();
  }
});

tryDetectAndReport();

// Retry for SPAs that render JSON-LD or og: tags after DOMContentLoaded.
setTimeout(() => { if (!lastReportedHadImage) tryDetectAndReport(); }, 1500);
setTimeout(() => { if (!lastReportedHadImage) tryDetectAndReport(); }, 4000);
