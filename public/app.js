const addForm = document.getElementById('add-form');
const newQueryInput = document.getElementById('new-query');
const addBtn = document.getElementById('add-btn');
const statusEl = document.getElementById('status');
const sseMeta = document.getElementById('sse-meta');
const queryGrid = document.getElementById('query-grid');
const gridEmpty = document.getElementById('grid-empty');
const viewGrid = document.getElementById('view-grid');
const viewDetail = document.getElementById('view-detail');
const backBtn = document.getElementById('back-btn');
const detailHeading = document.getElementById('detail-heading');
const detailCount = document.getElementById('detail-count');
const detailResults = document.getElementById('detail-results');
const detailError = document.getElementById('detail-error');
const refreshBtn = document.getElementById('refresh-btn');
const toastEl = document.getElementById('toast');
const toastIcon = document.getElementById('toast-icon');
const toastTitle = document.getElementById('toast-title');
const toastMessage = document.getElementById('toast-message');

let watches = [];
let selectedId = null;
let toastTimer = null;
let es = null;
/** @type {Set<string>} */
const scrapingWatchIds = new Set();

function setStatus(text) {
  statusEl.textContent = text || '';
}

function showToast({ title, message, variant = 'neutral', ms = 4800 }) {
  toastEl.hidden = false;
  toastEl.className = `toast toast--${variant}`;
  toastTitle.textContent = title || '';
  toastMessage.textContent = message || '';

  const glyphs = { success: '✓', neutral: '●', error: '!' };
  toastIcon.textContent = glyphs[variant] || glyphs.neutral;

  requestAnimationFrame(() => {
    toastEl.classList.add('is-visible');
  });

  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.classList.remove('is-visible');
    setTimeout(() => {
      toastEl.hidden = true;
    }, 400);
  }, ms);
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeAttr(s) {
  return escapeHtml(s).replace(/'/g, '&#39;');
}

function setScraping(watchId, on) {
  if (on) scrapingWatchIds.add(watchId);
  else scrapingWatchIds.delete(watchId);
  syncScrapingOnTiles();
}

function syncScrapingOnTiles() {
  queryGrid.querySelectorAll('.query-tile').forEach((el) => {
    const id = el.getAttribute('data-id');
    if (!id) return;
    el.classList.toggle('is-scraping', scrapingWatchIds.has(id));
  });
}

function applyWatchesState(next) {
  watches = Array.isArray(next) ? next.slice() : [];
  watches.sort((a, b) => String(a.query).localeCompare(String(b.query)));
  renderQueryGrid();
  syncScrapingOnTiles();
  if (selectedId) {
    const sum = watches.find((w) => w.id === selectedId);
    if (!sum) closeDetail();
    else syncDetailHeader(sum);
  }
}

function renderQueryGrid() {
  if (watches.length === 0) {
    queryGrid.innerHTML = '';
    gridEmpty.classList.remove('hidden');
    return;
  }
  gridEmpty.classList.add('hidden');

  queryGrid.innerHTML = watches
    .map((w) => {
      const pending = w.pendingNewCount > 0;
      const badge = pending
        ? `<span class="badge" aria-label="New listings">${w.pendingNewCount > 99 ? '99+' : w.pendingNewCount}</span>`
        : '<span class="badge hidden"></span>';
      const errLine = w.lastError
        ? `<p class="query-meta query-meta--error">${escapeHtml(w.lastError)}</p>`
        : '';
      const fetched = w.lastFetchedAt
        ? `<p class="query-meta">Updated ${formatTime(w.lastFetchedAt)}</p>`
        : '<p class="query-meta">Waiting for first fetch…</p>';
      const scraping = scrapingWatchIds.has(w.id) ? ' is-scraping' : '';
      return `
        <div
          class="query-tile${pending ? ' has-new' : ''}${scraping}"
          role="button"
          tabindex="0"
          data-id="${escapeAttr(w.id)}"
          aria-label="Open watch ${escapeAttr(w.query)}"
        >
          <div class="tile-busy" aria-hidden="true">
            <div class="spinner"></div>
            <span class="busy-label">Checking</span>
          </div>
          <div class="query-tile-top">
            <p class="query-label">${escapeHtml(w.query)}</p>
            <div style="display:flex;align-items:center;gap:0.25rem">
              ${badge}
              <button type="button" class="btn-icon" data-delete="${escapeAttr(w.id)}" title="Remove watch" aria-label="Remove ${escapeAttr(w.query)}">✕</button>
            </div>
          </div>
          <p class="query-meta">${w.listingCount} saved listing(s)</p>
          ${fetched}
          ${errLine}
        </div>`;
    })
    .join('');

  queryGrid.querySelectorAll('.query-tile').forEach((el) => {
    const id = el.getAttribute('data-id');
    el.addEventListener('click', (e) => {
      if (e.target.closest('[data-delete]')) return;
      if (el.classList.contains('is-scraping')) return;
      openDetail(id);
    });
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (e.target.closest('[data-delete]')) return;
        if (el.classList.contains('is-scraping')) return;
        openDetail(id);
      }
    });
  });

  queryGrid.querySelectorAll('[data-delete]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = btn.getAttribute('data-delete');
      if (!id) return;
      if (!confirm('Remove this watch?')) return;
      try {
        const res = await fetch(`/api/watches/${encodeURIComponent(id)}`, { method: 'DELETE' });
        if (!res.ok) throw new Error('Delete failed');
        if (selectedId === id) closeDetail();
        showToast({ variant: 'neutral', title: 'Watch removed', message: 'The search was deleted from your dashboard.', ms: 3200 });
      } catch (err) {
        showToast({ variant: 'error', title: 'Could not remove', message: err.message || 'Delete failed', ms: 5000 });
      }
    });
  });
}

function formatTime(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch {
    return iso;
  }
}

function syncDetailHeader(sum) {
  detailHeading.textContent = sum.query;
  detailCount.textContent = `${sum.listingCount} listing(s)`;
  if (sum.lastError) {
    detailError.textContent = sum.lastError;
    detailError.classList.remove('hidden');
  } else {
    detailError.classList.add('hidden');
  }
}

function listingCardHtml(item) {
  const thumb = item.imageUrl
    ? `<img src="${escapeAttr(item.imageUrl)}" alt="" loading="lazy" />`
    : `<div class="card-thumb-fallback" aria-hidden="true"></div>`;
  const ribbon = item.isNew ? '<span class="ribbon">New</span>' : '';
  const body = `
    <div class="card-body">
      <p class="card-title">${escapeHtml(item.title)}</p>
      <p class="card-price">${escapeHtml(item.price)}</p>
      <a href="${escapeAttr(item.url)}" target="_blank" rel="noopener noreferrer">Open on Facebook</a>
    </div>`;
  return `<article class="card${item.isNew ? ' is-new' : ''}"><div class="card-wrap">${ribbon}${thumb}</div>${body}</article>`;
}

async function refreshDetailListingsIfOpen(watchId) {
  if (selectedId !== watchId) return;
  try {
    const res = await fetch(`/api/watches/${encodeURIComponent(watchId)}`);
    const data = await res.json();
    if (!res.ok) return;
    syncDetailHeader(data);
    if (!data.listings || data.listings.length === 0) {
      detailResults.innerHTML =
        '<p class="empty">No listings yet. The next poll may populate results.</p>';
    } else {
      detailResults.innerHTML = data.listings.map(listingCardHtml).join('');
    }
  } catch {
    /* ignore */
  }
}

async function openDetail(id) {
  selectedId = id;
  viewGrid.classList.add('hidden');
  viewDetail.classList.remove('hidden');
  detailResults.innerHTML = '<p class="empty">Loading…</p>';

  let data;
  try {
    const res = await fetch(`/api/watches/${encodeURIComponent(id)}`);
    data = await res.json();
    if (!res.ok) throw new Error(data.error || res.statusText);
  } catch (err) {
    detailResults.innerHTML = `<p class="empty">${escapeHtml(err.message)}</p>`;
    return;
  }

  syncDetailHeader(data);
  if (!data.listings || data.listings.length === 0) {
    detailResults.innerHTML =
      '<p class="empty">No listings yet. First poll may take a minute after adding the watch.</p>';
  } else {
    detailResults.innerHTML = data.listings.map(listingCardHtml).join('');
  }

  try {
    await fetch(`/api/watches/${encodeURIComponent(id)}/ack`, { method: 'POST' });
  } catch {
    /* non-fatal */
  }
}

function closeDetail() {
  selectedId = null;
  viewDetail.classList.add('hidden');
  viewGrid.classList.remove('hidden');
}

function pulseTile(watchId) {
  const safe = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(watchId) : watchId;
  const tile = queryGrid.querySelector(`.query-tile[data-id="${safe}"]`);
  if (!tile) return;
  tile.classList.remove('pulse');
  void tile.offsetWidth;
  tile.classList.add('pulse');
}

function handleScrapeEnd(payload) {
  const q = payload.query || 'watch';
  if (payload.error) {
    showToast({
      variant: 'error',
      title: 'Watch failed',
      message: `“${q}”: ${payload.error}`,
      ms: 6500,
    });
    return;
  }
  if (payload.becameHydrated) {
    const n = payload.listingCount ?? 0;
    showToast({
      variant: 'success',
      title: 'Watch ready',
      message: n ? `Saved ${n} listing(s) for “${q}”.` : `Connected for “${q}” — no listings parsed yet.`,
      ms: 5200,
    });
    return;
  }
  if (payload.newCount > 0) {
    const label = payload.newCount === 1 ? 'listing' : 'listings';
    showToast({
      variant: 'success',
      title: 'New on Marketplace',
      message: `${payload.newCount} new ${label} for “${q}”.`,
      ms: 5500,
    });
    return;
  }
  showToast({
    variant: 'neutral',
    title: 'Up to date',
    message: `No new listings for “${q}”.`,
    ms: 4000,
  });
}

function connectSse() {
  if (es) {
    try {
      es.close();
    } catch {
      /* ignore */
    }
  }
  es = new EventSource('/api/events');

  es.onopen = () => {
    sseMeta.textContent = 'Live';
    sseMeta.classList.add('is-live');
    sseMeta.classList.remove('is-error');
  };

  es.onerror = () => {
    sseMeta.textContent = 'Reconnecting';
    sseMeta.classList.remove('is-live');
    sseMeta.classList.add('is-error');
  };

  es.addEventListener('snapshot', (ev) => {
    try {
      const data = JSON.parse(ev.data);
      applyWatchesState(data.watches);
    } catch {
      /* ignore */
    }
  });

  es.addEventListener('watches_state', (ev) => {
    try {
      const data = JSON.parse(ev.data);
      applyWatchesState(data.watches);
    } catch {
      /* ignore */
    }
  });

  es.addEventListener('watch_scrape_start', (ev) => {
    try {
      const data = JSON.parse(ev.data);
      if (data.watchId) setScraping(data.watchId, true);
    } catch {
      /* ignore */
    }
  });

  es.addEventListener('watch_scrape_end', (ev) => {
    try {
      const data = JSON.parse(ev.data);
      if (data.watchId) setScraping(data.watchId, false);
      handleScrapeEnd(data);
      refreshDetailListingsIfOpen(data.watchId);
    } catch {
      /* ignore */
    }
  });

  es.addEventListener('new_listings', (ev) => {
    try {
      const data = JSON.parse(ev.data);
      pulseTile(data.watchId);
      refreshDetailListingsIfOpen(data.watchId);
    } catch {
      /* ignore */
    }
  });
}

addForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const query = newQueryInput.value.trim();
  if (!query) return;
  addBtn.disabled = true;
  setStatus('Adding watch…');
  try {
    const res = await fetch('/api/watches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || res.statusText);
    newQueryInput.value = '';
    setStatus(`Watch “${data.watch.query}” added. You will see a spinner while the first check runs.`);
    showToast({
      variant: 'neutral',
      title: 'Watch added',
      message: `“${data.watch.query}” will appear in the grid and update automatically.`,
      ms: 4200,
    });
  } catch (err) {
    setStatus(err.message || 'Failed to add watch');
    showToast({ variant: 'error', title: 'Add failed', message: err.message || 'Could not add watch', ms: 5000 });
  } finally {
    addBtn.disabled = false;
  }
});

backBtn.addEventListener('click', () => closeDetail());

refreshBtn.addEventListener('click', async () => {
  if (!selectedId) return;
  refreshBtn.disabled = true;
  try {
    await fetch(`/api/watches/${encodeURIComponent(selectedId)}/refresh`, { method: 'POST' });
    setStatus('Refresh queued — watch the tile for progress.');
    showToast({
      variant: 'neutral',
      title: 'Refresh queued',
      message: 'A new Marketplace check is running for this watch.',
      ms: 3500,
    });
  } catch (err) {
    setStatus(err.message || 'Refresh failed');
    showToast({ variant: 'error', title: 'Refresh failed', message: err.message || 'Try again shortly.', ms: 4500 });
  } finally {
    refreshBtn.disabled = false;
  }
});

async function bootstrap() {
  try {
    const res = await fetch('/api/watches');
    const data = await res.json();
    if (res.ok) applyWatchesState(data.watches);
  } catch {
    setStatus('Could not load watches.');
  }

  fetch('/api/health')
    .then((r) => r.json())
    .then((h) => {
      if (!h.cookiesFileExists) {
        setStatus('Tip: add cookies.json for an authenticated session.');
      }
    })
    .catch(() => {});

  connectSse();
}

bootstrap();
