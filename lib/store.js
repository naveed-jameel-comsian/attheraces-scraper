const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
const STORE_FILE = path.join(DATA_DIR, 'watches.json');

const MAX_LISTINGS_PER_WATCH = Number(process.env.MAX_LISTINGS_PER_WATCH) || 200;

function itemIdFromUrl(url) {
  const m = String(url).match(/\/marketplace\/item\/(\d+)/);
  return m ? m[1] : String(url);
}

function defaultState() {
  return { watches: [] };
}

function readState() {
  try {
    if (!fs.existsSync(STORE_FILE)) return defaultState();
    const raw = fs.readFileSync(STORE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.watches)) return defaultState();
    for (const w of parsed.watches) {
      if (w.hydrated === undefined) {
        w.hydrated = Boolean(w.lastFetchedAt && Array.isArray(w.listings) && w.listings.length > 0);
      }
    }
    return parsed;
  } catch {
    return defaultState();
  }
}

function writeState(state) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${STORE_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmp, STORE_FILE);
}

let state = readState();

function persist() {
  writeState(state);
}

function summary(w) {
  return {
    id: w.id,
    query: w.query,
    enabled: w.enabled !== false,
    hydrated: Boolean(w.hydrated),
    listingCount: Array.isArray(w.listings) ? w.listings.length : 0,
    pendingNewCount: w.pendingNewCount || 0,
    lastFetchedAt: w.lastFetchedAt || null,
    lastError: w.lastError || null,
  };
}

function getAllSummaries() {
  return state.watches.map(summary);
}

function findWatch(id) {
  return state.watches.find((w) => w.id === id) || null;
}

function addWatch(queryText) {
  const query = String(queryText || '').trim();
  if (!query) throw new Error('Query is required');
  const w = {
    id: crypto.randomUUID(),
    query,
    enabled: true,
    listings: [],
    pendingNewCount: 0,
    hydrated: false,
    lastFetchedAt: null,
    lastError: null,
    createdAt: new Date().toISOString(),
  };
  state.watches.push(w);
  persist();
  return w;
}

function removeWatch(id) {
  const i = state.watches.findIndex((w) => w.id === id);
  if (i === -1) return false;
  state.watches.splice(i, 1);
  persist();
  return true;
}

function ackWatch(id) {
  const w = findWatch(id);
  if (!w) return null;
  w.pendingNewCount = 0;
  if (Array.isArray(w.listings)) {
    for (const L of w.listings) delete L.isNew;
  }
  persist();
  return w;
}

function mergeScrapeResult(watchId, incomingListings) {
  const w = findWatch(watchId);
  if (!w) return { newListings: [], watch: null, becameHydrated: false };

  const existingById = new Map();
  for (const L of w.listings) {
    const id = L.itemId || itemIdFromUrl(L.url);
    existingById.set(id, L);
  }

  const newListings = [];
  const wasHydrated = Boolean(w.hydrated);

  for (const raw of incomingListings) {
    const itemId = itemIdFromUrl(raw.url);
    const row = {
      itemId,
      url: raw.url,
      title: raw.title,
      price: raw.price,
      imageUrl: raw.imageUrl || '',
      discoveredAt: new Date().toISOString(),
    };

    if (!existingById.has(itemId)) {
      if (wasHydrated) row.isNew = true;
      newListings.push(row);
      existingById.set(itemId, row);
    } else {
      const prev = existingById.get(itemId);
      prev.title = row.title;
      prev.price = row.price;
      prev.imageUrl = row.imageUrl || prev.imageUrl;
      prev.lastRefreshedAt = row.discoveredAt;
    }
  }

  const merged = Array.from(existingById.values()).sort((a, b) => {
    const ta = new Date(a.discoveredAt || 0).getTime();
    const tb = new Date(b.discoveredAt || 0).getTime();
    return tb - ta;
  });

  w.listings = merged.slice(0, MAX_LISTINGS_PER_WATCH);
  w.lastFetchedAt = new Date().toISOString();
  w.lastError = null;

  if (!wasHydrated) {
    w.hydrated = true;
    w.pendingNewCount = 0;
    for (const L of w.listings) delete L.isNew;
  } else {
    w.pendingNewCount = (w.pendingNewCount || 0) + newListings.length;
  }

  persist();

  const notifyNew = wasHydrated ? newListings : [];
  return { newListings: notifyNew, watch: w, becameHydrated: !wasHydrated };
}

function setWatchError(watchId, message) {
  const w = findWatch(watchId);
  if (!w) return;
  w.lastError = String(message || 'Unknown error');
  w.lastFetchedAt = new Date().toISOString();
  persist();
}

function getWatchPublic(id) {
  const w = findWatch(id);
  if (!w) return null;
  return {
    ...summary(w),
    listings: w.listings || [],
    createdAt: w.createdAt,
  };
}

module.exports = {
  getAllSummaries,
  getWatchPublic,
  findWatch,
  addWatch,
  removeWatch,
  ackWatch,
  mergeScrapeResult,
  setWatchError,
  itemIdFromUrl,
  STORE_FILE,
};
