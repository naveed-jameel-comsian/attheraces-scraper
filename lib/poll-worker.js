const store = require('./store');
const { searchMarketplace } = require('./marketplace');
const sse = require('./sse-hub');

const POLL_MS = Math.max(30_000, Number(process.env.POLL_INTERVAL_MS) || 60_000);
const GAP_BETWEEN_WATCHES_MS = Math.max(0, Number(process.env.POLL_GAP_MS) || 8_000);
const SCRAPE_LIMIT = Math.min(50, Math.max(5, Number(process.env.POLL_SCRAPE_LIMIT) || 30));

let timer = null;
let stopping = false;
let running = false;
let chain = Promise.resolve();

function enqueue(fn) {
  chain = chain.then(fn).catch((err) => console.error('[worker]', err));
  return chain;
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function broadcastWatches() {
  sse.broadcast('watches_state', { watches: store.getAllSummaries() });
}

async function refreshOneWatch(watch) {
  if (watch.enabled === false) return;

  sse.broadcast('watch_scrape_start', { watchId: watch.id, query: watch.query });

  const endPayload = {
    watchId: watch.id,
    query: watch.query,
    newCount: 0,
    listingCount: 0,
    becameHydrated: false,
    error: null,
  };

  try {
    const result = await searchMarketplace(watch.query, { limit: SCRAPE_LIMIT });
    const { newListings, watch: updated, becameHydrated } = store.mergeScrapeResult(
      watch.id,
      result.listings
    );

    endPayload.newCount = newListings.length;
    endPayload.listingCount = updated && updated.listings ? updated.listings.length : 0;
    endPayload.becameHydrated = Boolean(becameHydrated);

    broadcastWatches();

    if (newListings.length > 0) {
      sse.broadcast('new_listings', {
        watchId: watch.id,
        query: watch.query,
        newCount: newListings.length,
        newListings,
        listingCount: updated.listings.length,
      });
    }
  } catch (err) {
    const msg = err.message || String(err);
    endPayload.error = msg;
    store.setWatchError(watch.id, msg);
    sse.broadcast('watch_error', {
      watchId: watch.id,
      query: watch.query,
      error: msg,
    });
    broadcastWatches();
    const w = store.findWatch(watch.id);
    endPayload.listingCount = w && w.listings ? w.listings.length : 0;
  } finally {
    sse.broadcast('watch_scrape_end', endPayload);
  }
}

async function runCycle() {
  if (running) return;
  running = true;
  try {
    const watches = store.getAllSummaries().filter((w) => w.enabled !== false);
    if (watches.length === 0) return;

    sse.broadcast('poll_cycle_start', { at: new Date().toISOString(), watchCount: watches.length });

    for (const summary of watches) {
      if (stopping) break;
      const full = store.findWatch(summary.id);
      if (!full) continue;
      await enqueue(async () => {
        await refreshOneWatch(full);
      });
      if (GAP_BETWEEN_WATCHES_MS > 0 && !stopping) {
        await delay(GAP_BETWEEN_WATCHES_MS);
      }
    }

    sse.broadcast('poll_cycle_end', { at: new Date().toISOString() });
  } finally {
    running = false;
  }
}

function startWorker() {
  if (timer !== null) return;
  stopping = false;

  const tick = async () => {
    if (stopping) return;
    await runCycle().catch((e) => console.error('[worker] cycle', e));
    if (stopping) return;
    timer = setTimeout(tick, POLL_MS);
  };

  timer = setTimeout(tick, 5_000);
}

function stopWorker() {
  stopping = true;
  if (timer) clearTimeout(timer);
  timer = null;
}

function scheduleImmediateFetchForWatch(watchId) {
  const full = store.findWatch(watchId);
  if (!full) return;
  enqueue(async () => {
    await refreshOneWatch(full);
  });
}

module.exports = {
  startWorker,
  stopWorker,
  runCycle,
  scheduleImmediateFetchForWatch,
  POLL_MS,
};
