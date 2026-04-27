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
    });
    container.appendChild(chip);
  }
}

document
  .getElementById("settings-toggle")
  .addEventListener("click", async () => {
    const section = document.getElementById("settings-section");
    section.hidden = !section.hidden;
    if (!section.hidden) {
      renderSizeChips(await loadSizes());
    }
  });

// Pre-render chips so state is ready even before settings are opened.
loadSizes().then(renderSizeChips);

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
  appendNextPage();
}

function appendNextPage() {
  const grid = document.getElementById("alternatives-grid");
  const loadMore = document.getElementById("load-more");
  const nextBatch = _allAlternatives.slice(
    _visibleCount,
    _visibleCount + PAGE_SIZE,
  );
  const isLoadMore = _visibleCount > 0;

  if (
    isLoadMore &&
    nextBatch.length > 0 &&
    !grid.classList.contains("has-more")
  ) {
    // Capture the stretched card height before switching row mode
    const cardHeight = grid.children[0]?.offsetHeight ?? 0;
    grid.style.setProperty("--card-row-height", cardHeight + "px");
    grid.classList.add("has-more");
  }

  for (const item of nextBatch) {
    grid.appendChild(makeCard(item));
  }

  _visibleCount += nextBatch.length;
  loadMore.hidden = _visibleCount >= _allAlternatives.length;

  if (isLoadMore && nextBatch.length > 0) {
    const newCards = grid.querySelectorAll(".alt-card");
    const firstNew = newCards[newCards.length - nextBatch.length];
    if (firstNew) {
      firstNew.scrollIntoView({ behavior: "smooth", block: "start" });
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
}

function scoreTier(score) {
  if (score >= 4) return "good";
  if (score === 3) return "fair";
  return "poor";
}

function renderProduct(data) {
  document.getElementById("waiting-state").hidden = true;
  document.getElementById("product-state").hidden = false;

  document.getElementById("product-brand").textContent =
    data.product.brand || data.product.name || "";

  renderTierLadder(data.scoreData);

  renderAlternatives(data.alternatives);
}

function showWaitingState() {
  document.getElementById("waiting-state").hidden = false;
  document.getElementById("product-state").hidden = true;
  document.getElementById("product-brand").textContent = "";
  document.querySelectorAll(".tier-rung").forEach((r) => r.classList.remove("active"));
  document.getElementById("score-sublabel").textContent = "";
  const retailerNote = document.getElementById("retailer-note");
  retailerNote.textContent = "";
  retailerNote.hidden = true;
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "PRODUCT_DATA") {
    renderProduct(message);
  }
  if (message.type === "SHOW_WAITING_STATE") {
    showWaitingState();
  }
});

function requestCurrentProduct(retriesLeft) {
  chrome.runtime.sendMessage({ type: "GET_CURRENT_PRODUCT" }, (response) => {
    if (response) {
      renderProduct(response);
    } else if (retriesLeft > 0) {
      setTimeout(() => requestCurrentProduct(retriesLeft - 1), 1500);
    }
  });
}

requestCurrentProduct(6);
