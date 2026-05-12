const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const selectors = require('./selectors');

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const ROOT = path.join(__dirname, '..');
const USER_DATA_DIR = path.join(ROOT, 'browser-data');
const COOKIES_FILE = path.join(ROOT, 'cookies.json');

let browserContextPromise = null;

/** Playwright only accepts 'Strict' | 'Lax' | 'None' (Pascal case). */
function normalizeSameSite(value) {
  if (value === undefined || value === null || value === '') return 'Lax';
  const s = String(value).trim();
  if (s === 'Strict' || s === 'Lax' || s === 'None') return s;
  const lower = s.toLowerCase();
  if (lower === 'strict') return 'Strict';
  if (lower === 'lax') return 'Lax';
  if (lower === 'none' || lower === 'no_restriction') return 'None';
  // Chrome / extensions sometimes export these
  if (lower === 'unspecified' || lower === 'extended' || lower === 'moderate') return 'Lax';
  return 'Lax';
}

function normalizeCookies(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((c) => {
    const sameSite = normalizeSameSite(c.sameSite);
    const secure = sameSite === 'None' ? true : c.secure !== false;
    return {
      name: c.name,
      value: String(c.value ?? ''),
      domain: c.domain || '.facebook.com',
      path: c.path || '/',
      expires: typeof c.expires === 'number' ? c.expires : -1,
      httpOnly: Boolean(c.httpOnly),
      secure,
      sameSite,
    };
  });
}

async function loadCookiesIntoContext(context) {
  if (!fs.existsSync(COOKIES_FILE)) return;
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(COOKIES_FILE, 'utf8'));
  } catch {
    return;
  }
  const cookies = normalizeCookies(parsed);
  if (cookies.length) await context.addCookies(cookies);
}

function getContext() {
  if (!browserContextPromise) {
    browserContextPromise = (async () => {
      const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
        headless: false,
        args: ['--disable-blink-features=AutomationControlled'],
        viewport: { width: 1280, height: 900 },
      });
      await loadCookiesIntoContext(context);
      return context;
    })();
  }
  return browserContextPromise;
}

function buildSearchUrl(query) {
  const base =
    process.env.MARKETPLACE_SEARCH_BASE ||
    'https://www.facebook.com/marketplace/search';
  const q = encodeURIComponent(query.trim());
  return `${base}/?query=${q}`;
}

/**
 * Best-effort extraction: Facebook markup changes often; tune selectors.js.
 */
async function scrapeListings(page, limit = 24) {
  await delay(2000);

  const items = await page.evaluate(
    ({ anchorSel, max }) => {
      const anchors = Array.from(document.querySelectorAll(anchorSel));
      const seen = new Set();
      const rows = [];

      for (const a of anchors) {
        const href = a.getAttribute('href') || '';
        if (!href.includes('/marketplace/item/')) continue;
        const fullUrl = href.startsWith('http')
          ? href
          : `https://www.facebook.com${href.split('?')[0]}`;
        if (seen.has(fullUrl)) continue;
        seen.add(fullUrl);

        let card = a;
        for (let i = 0; i < 8 && card; i++) {
          if (card.querySelector('img')) break;
          card = card.parentElement;
        }
        if (!card) card = a.parentElement || a;

        const img = card.querySelector('img');
        const imageUrl = img?.getAttribute('src') || '';

        const texts = [];
        card.querySelectorAll('span, div').forEach((el) => {
          const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
          if (t.length > 2 && t.length < 200) texts.push(t);
        });
        const currencyLike = (t) => /[$€£¥]|USD|CAD|EUR|GBP|\d/.test(t);
        let price = '';
        let title = '';
        for (const t of texts) {
          if (!price && currencyLike(t) && t.length < 40) {
            price = t;
            continue;
          }
          if (!title && t.length > 5 && !currencyLike(t)) {
            title = t;
          }
        }
        if (!title) title = a.getAttribute('aria-label')?.trim() || 'Listing';

        rows.push({
          url: fullUrl,
          title,
          price: price || '—',
          imageUrl,
        });
        if (rows.length >= max) break;
      }
      return rows;
    },
    { anchorSel: selectors.listingAnchor, limit }
  );

  return items;
}

async function searchMarketplace(query, options = {}) {
  const { limit = 24 } = options;
  let page;

  try {
    const context = await getContext();
    page = await context.newPage();
    const url = buildSearchUrl(query);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await delay(3000);
    const listings = await scrapeListings(page, limit);
    return { query, url, listings, count: listings.length };
  } finally {
    if (page) await page.close().catch(() => {});
    await closeBrowser();
  }
}

/**
 * Closes the Chromium persistent context. Next scrape launches a new browser
 * using the same USER_DATA_DIR so login/profile/cookies on disk stay intact.
 */
async function closeBrowser() {
  const pending = browserContextPromise;
  browserContextPromise = null;
  if (!pending) return;
  const ctx = await pending.catch(() => null);
  if (ctx) await ctx.close().catch(() => {});
}

module.exports = {
  searchMarketplace,
  closeBrowser,
  COOKIES_FILE,
  USER_DATA_DIR,
};
