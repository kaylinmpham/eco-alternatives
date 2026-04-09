function renderStars(score) {
  const container = document.getElementById('stars');
  container.innerHTML = '';

  for (let i = 1; i <= 5; i++) {
    const star = document.createElement('span');
    star.className = i <= score ? 'star filled' : 'star empty';
    star.textContent = i <= score ? '★' : '☆';
    container.appendChild(star);
  }
}

function renderAlternatives(alternatives) {
  const grid = document.getElementById('alternatives-grid');
  grid.innerHTML = '';

  for (const item of alternatives) {
    const card = document.createElement('a');
    card.className = 'alt-card';
    card.href = item.url;
    card.target = '_blank';
    card.rel = 'noopener noreferrer';

    const img = document.createElement('img');
    img.src = item.image;
    img.alt = item.platform;

    const info = document.createElement('div');
    info.className = 'card-info';

    const nameEl = document.createElement('span');
    nameEl.className = 'card-name';
    nameEl.textContent = item.name;

    const priceEl = document.createElement('span');
    priceEl.className = 'card-price';
    priceEl.textContent = item.price;

    const platformEl = document.createElement('span');
    platformEl.className = 'card-platform';
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
  if (score >= 4) return 'good';
  if (score === 3) return 'fair';
  return 'poor';
}

function renderProduct(data) {
  document.getElementById('waiting-state').hidden = true;
  document.getElementById('product-state').hidden = false;

  document.getElementById('brand-name').textContent =
    data.product.brand || data.product.name || 'Eco Alternatives';

  const scoreBox = document.getElementById('score-box');
  const scoreValue = document.getElementById('score-value');

  if (data.scoreData.score !== null) {
    scoreValue.textContent = data.scoreData.score;
    scoreBox.dataset.tier = scoreTier(data.scoreData.score);
    renderStars(data.scoreData.score);
  } else {
    scoreValue.textContent = '?';
    scoreBox.dataset.tier = 'unknown';
    document.getElementById('stars').innerHTML = '';
  }

  document.getElementById('score-label').textContent = data.scoreData.label;
  renderAlternatives(data.alternatives);
}

function showWaitingState() {
  document.getElementById('waiting-state').hidden = false;
  document.getElementById('product-state').hidden = true;
  document.getElementById('brand-name').textContent = 'Eco Alternatives';
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'PRODUCT_DATA') {
    renderProduct(message);
  }
  if (message.type === 'SHOW_WAITING_STATE') {
    showWaitingState();
  }
});

function requestCurrentProduct(retriesLeft) {
  chrome.runtime.sendMessage({ type: 'GET_CURRENT_PRODUCT' }, (response) => {
    if (response) {
      renderProduct(response);
    } else if (retriesLeft > 0) {
      setTimeout(() => requestCurrentProduct(retriesLeft - 1), 1500);
    }
  });
}

requestCurrentProduct(6);
