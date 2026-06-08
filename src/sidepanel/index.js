// ── Size preferences ──────────────────────────────────────────────────────

const SIZE_OPTIONS = ["XS", "S", "M", "L", "XL", "2XL"];

async function loadSizes() {
  const { sizes = [] } = await chrome.storage.local.get("sizes");
  return sizes;
}

function renderSizeChips(selectedSizes) {
  const container = document.getElementById("size-chips");
  container.innerHTML = "";
  for (const size of SIZE_OPTIONS) {
    const chip = document.createElement("button");
    chip.className =
      "size-chip" + (selectedSizes.includes(size) ? " selected" : "");
    chip.textContent = size;
    chip.addEventListener("click", async () => {
      const current = await loadSizes();
      const updated = current.includes(size)
        ? current.filter((s) => s !== size)
        : [...current, size];
      await chrome.storage.local.set({ sizes: updated });
      renderSizeChips(updated);
      updateSizeToggleLabel(updated);
    });
    container.appendChild(chip);
  }
}

function updateSizeToggleLabel(sizes) {
  document.getElementById("size-toggle").classList.toggle(
    "active",
    sizes && sizes.length > 0,
  );
}

document.getElementById("size-toggle").addEventListener("click", async () => {
  const sizePanel = document.getElementById("size-panel");
  document.getElementById("price-panel").hidden = true;
  sizePanel.hidden = !sizePanel.hidden;
  if (!sizePanel.hidden) {
    const sizes = await loadSizes();
    renderSizeChips(sizes);
  }
});

loadSizes().then(updateSizeToggleLabel);

// ── Price filter ──────────────────────────────────────────────────────────

let _productPrice = null;
let _priceFilterActive = false;

function parsePrice(str) {
  if (!str) return null;
  const num = parseFloat(str.replace(/[^0-9.]/g, ""));
  return isNaN(num) ? null : num;
}

function getFilteredAlternatives() {
  if (!_priceFilterActive || !_productPrice) return _allAlternatives;
  const productNum = parsePrice(_productPrice);
  if (productNum === null) return _allAlternatives;
  return _allAlternatives.filter((alt) => {
    const altNum = parsePrice(alt.price);
    return altNum !== null && altNum < productNum;
  });
}

document.getElementById("price-filter").addEventListener("click", () => {
  const pricePanel = document.getElementById("price-panel");
  document.getElementById("size-panel").hidden = true;
  pricePanel.hidden = !pricePanel.hidden;
});

document.querySelectorAll(".price-option").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".price-option").forEach((b) => b.classList.remove("selected"));
    btn.classList.add("selected");
    _priceFilterActive = btn.dataset.filter === "under";
    document.getElementById("price-filter").classList.toggle("active", _priceFilterActive);
    rerender();
  });
});

// ── Scoring + alternatives rendering ─────────────────────────────────────

const SCORE_SUBLABEL = {
  1: "Poor transparency across ethics, labour & environment",
  2: "Below average practices with limited transparency",
  3: "Some sustainability efforts, but not cutting it",
  4: "Good practices — meaningful commitments across key areas",
  5: "Industry-leading sustainability across all areas",
};

const PAGE_SIZE = 4;
let _allAlternatives = [];
let _visibleCount = 0;

function rerender() {
  _visibleCount = 0;
  const grid = document.getElementById("alternatives-grid");
  grid.innerHTML = "";
  grid.classList.remove("has-more");
  grid.style.removeProperty("--card-row-height");
  const filtered = getFilteredAlternatives();
  document.getElementById("no-results-state").hidden = filtered.length > 0;
  if (filtered.length > 0) appendNextPage();
  else document.getElementById("load-more").hidden = true;
}

function makeCard(item) {
  const card = document.createElement("a");
  card.className = "alt-card";
  card.href = item.url;
  card.target = "_blank";
  card.rel = "noopener noreferrer";

  const img = document.createElement("img");
  img.src = item.image;
  img.alt = item.platform;

  const info = document.createElement("div");
  info.className = "card-info";

  const nameEl = document.createElement("span");
  nameEl.className = "card-name";
  nameEl.textContent = item.name;

  const priceEl = document.createElement("span");
  priceEl.className = "card-price";
  priceEl.textContent = item.price;

  const platformEl = document.createElement("span");
  platformEl.className = "card-platform";
  platformEl.textContent = item.platform;

  info.appendChild(nameEl);
  info.appendChild(priceEl);
  info.appendChild(platformEl);
  card.appendChild(img);
  card.appendChild(info);
  return card;
}

function renderAlternatives(alternatives) {
  _allAlternatives = alternatives;
  _visibleCount = 0;
  const grid = document.getElementById("alternatives-grid");
  grid.innerHTML = "";
  grid.classList.remove("has-more");
  grid.style.removeProperty("--card-row-height");
  const filtered = getFilteredAlternatives();
  document.getElementById("no-results-state").hidden = filtered.length > 0;
  if (filtered.length > 0) appendNextPage();
  else document.getElementById("load-more").hidden = true;
}

function appendNextPage() {
  const filtered = getFilteredAlternatives();
  const grid = document.getElementById("alternatives-grid");
  const loadMore = document.getElementById("load-more");
  const nextBatch = filtered.slice(_visibleCount, _visibleCount + PAGE_SIZE);
  const isLoadMore = _visibleCount > 0;

  if (
    isLoadMore &&
    nextBatch.length > 0 &&
    !grid.classList.contains("has-more")
  ) {
    const cardHeight = grid.children[0]?.offsetHeight ?? 0;
    grid.style.setProperty("--card-row-height", cardHeight + "px");
    grid.classList.add("has-more");
  }

  for (const item of nextBatch) {
    grid.appendChild(makeCard(item));
  }

  _visibleCount += nextBatch.length;
  const exhausted = _visibleCount >= filtered.length;
  loadMore.disabled = exhausted;
  loadMore.hidden = false;

  if (isLoadMore && nextBatch.length > 0) {
    const newCards = grid.querySelectorAll(".alt-card");
    const firstNew = newCards[newCards.length - nextBatch.length];
    if (firstNew) {
      const section = document.getElementById("alternatives-section");
      const delta = firstNew.getBoundingClientRect().top - section.getBoundingClientRect().top;
      section.scrollBy({ top: delta, behavior: "smooth" });
    }
  }
}

document.getElementById("load-more").addEventListener("click", appendNextPage);

const TIER_LABEL = { 1: "We Avoid", 2: "Poor", 3: "Fair", 4: "Good", 5: "Great" };

function renderTierLadder(scoreData) {
  const score = scoreData.score;
  document.querySelectorAll(".tier-rung").forEach((rung) => {
    const pos = parseInt(rung.dataset.pos, 10);
    rung.classList.toggle("active", pos === score);
  });
  document.getElementById("score-sublabel").textContent =
    score !== null
      ? (SCORE_SUBLABEL[score] ?? "")
      : "No sustainability data for this brand";

  const retailerNote = document.getElementById("retailer-note");
  if (scoreData.retailerName && scoreData.retailerScore) {
    retailerNote.textContent =
      `Sold via ${scoreData.retailerName} — rated ${TIER_LABEL[scoreData.retailerScore]}`;
    retailerNote.hidden = false;
  } else {
    retailerNote.textContent = "";
    retailerNote.hidden = true;
  }

  document.getElementById("ai-note").hidden = scoreData.source !== "ai";
}

function renderProduct(data) {
  document.getElementById("waiting-state").hidden = true;
  document.getElementById("loading-state").hidden = true;
  document.getElementById("product-state").hidden = false;

  const { product, scoreData } = data;

  // Set up price filter for this product.
  _productPrice = product.price || null;
  _priceFilterActive = false;
  const priceFilterBtn = document.getElementById("price-filter");
  priceFilterBtn.classList.remove("active");
  document.getElementById("price-panel").hidden = true;
  document.querySelectorAll(".price-option").forEach((b) => b.classList.remove("selected"));
  document.querySelector('.price-option[data-filter="any"]').classList.add("selected");
  if (_productPrice) {
    document.getElementById("price-under-option").textContent = `Only under ${_productPrice}`;
    priceFilterBtn.hidden = false;
  } else {
    priceFilterBtn.hidden = true;
  }

  if (scoreData.retailerIsPrimary) {
    document.getElementById("product-brand").textContent = scoreData.retailerName;
    const retailerNote = document.getElementById("retailer-note");
    retailerNote.textContent = `Stocking: ${product.brand || product.name}`;
    retailerNote.hidden = false;
    renderTierLadder({ score: scoreData.retailerScore, source: scoreData.retailerSource });
  } else {
    document.getElementById("product-brand").textContent =
      product.brand || product.name || "";
    renderTierLadder(scoreData);
  }

  renderAlternatives(data.alternatives);
}

function showWaitingState() {
  document.getElementById("waiting-state").hidden = false;
  document.getElementById("loading-state").hidden = true;
  document.getElementById("product-state").hidden = true;
  document.getElementById("product-brand").textContent = "";
  document.querySelectorAll(".tier-rung").forEach((r) => r.classList.remove("active"));
  document.getElementById("score-sublabel").textContent = "";
  document.getElementById("retailer-note").textContent = "";
  document.getElementById("retailer-note").hidden = true;
  document.getElementById("ai-note").hidden = true;
  _productPrice = null;
  _priceFilterActive = false;
  document.getElementById("price-filter").hidden = true;
  document.getElementById("price-filter").classList.remove("active");
  document.getElementById("price-panel").hidden = true;
  document.querySelectorAll(".price-option").forEach((b) => b.classList.remove("selected"));
  document.querySelector('.price-option[data-filter="any"]').classList.add("selected");
  document.getElementById("size-panel").hidden = true;
}

function showLoadingState(brand) {
  document.getElementById("waiting-state").hidden = true;
  document.getElementById("loading-state").hidden = false;
  document.getElementById("product-state").hidden = true;
  document.getElementById("loading-brand-name").textContent = brand || "item";
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "PRODUCT_DATA") {
    renderProduct(message);
  }
  if (message.type === "SHOW_WAITING_STATE") {
    showWaitingState();
  }
  if (message.type === "SHOW_LOADING_STATE") {
    showLoadingState(message.brand);
  }
});

function requestCurrentProduct(retriesLeft) {
  chrome.runtime.sendMessage({ type: "GET_CURRENT_PRODUCT" }, (response) => {
    if (response?.loading) {
      showLoadingState(response.brand);
    } else if (response) {
      renderProduct(response);
    } else if (retriesLeft > 0) {
      setTimeout(() => requestCurrentProduct(retriesLeft - 1), 1500);
    } else {
      showWaitingState();
    }
  });
}

chrome.tabs.onActivated.addListener(() => {
  showWaitingState();
  requestCurrentProduct(3);
});

requestCurrentProduct(6);
