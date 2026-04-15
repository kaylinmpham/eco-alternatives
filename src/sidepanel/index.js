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

const LEAF_SVG_FILLED = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"><path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10z"/><path d="M2 21c0-3 1.85-5.36 5.08-6C9.5 14.52 12 13 13 12" fill="none"/></svg>`;
const LEAF_SVG_EMPTY = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10z"/><path d="M2 21c0-3 1.85-5.36 5.08-6C9.5 14.52 12 13 13 12"/></svg>`;

function renderStars(score) {
  const container = document.getElementById("stars");
  container.innerHTML = "";

  for (let i = 1; i <= 5; i++) {
    const leaf = document.createElement("span");
    leaf.className = i <= score ? "star filled" : "star empty";
    leaf.innerHTML = i <= score ? LEAF_SVG_FILLED : LEAF_SVG_EMPTY;
    container.appendChild(leaf);
  }
}

function renderAlternatives(alternatives) {
  const grid = document.getElementById("alternatives-grid");
  grid.innerHTML = "";

  for (const item of alternatives) {
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
    grid.appendChild(card);
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

  document.getElementById("brand-name").textContent =
    data.product.brand || data.product.name || "Mint";

  const scoreBox = document.getElementById("score-box");
  const scoreValue = document.getElementById("score-value");

  if (data.scoreData.score !== null) {
    scoreValue.textContent = data.scoreData.score;
    scoreBox.dataset.tier = scoreTier(data.scoreData.score);
    renderStars(data.scoreData.score);
  } else {
    scoreValue.textContent = "?";
    scoreBox.dataset.tier = "unknown";
    document.getElementById("stars").innerHTML = "";
  }

  document.getElementById("score-label").textContent = data.scoreData.label;
  renderAlternatives(data.alternatives);
}

function showWaitingState() {
  document.getElementById("waiting-state").hidden = false;
  document.getElementById("product-state").hidden = true;
  document.getElementById("brand-name").textContent = "Mint";
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
