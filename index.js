const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth');

chromium.use(stealth())

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const ROOT = path.join(__dirname, '.');
const USER_DATA_DIR = path.join(ROOT, 'browser-data');
const COOKIES_FILE = path.join(ROOT, 'cookies.json');
const THREAD_TEXT = process.env.THREAD_TEXT || 'Hello from Threads!';
console.log('User data dir:', COOKIES_FILE);

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

async function start() {
  let page;

  try {
    const context = await getContext();
    page = await context.newPage();
    const url = "https://www.threads.com";
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await delay(6000);

    const newThreadBtn = page.getByRole('button', { name: 'New thread' });
    await newThreadBtn.waitFor({ state: 'visible', timeout: 15000 });
    await newThreadBtn.click();

    const composer = page.getByRole('textbox', { name: /Type to compose a new post/i });
    await composer.waitFor({ state: 'visible', timeout: 15000 });
    await composer.click();
    await composer.pressSequentially(THREAD_TEXT, { delay: 50 });

    const postBtn = page.getByRole('button', { name: 'Post', exact: true });
    await postBtn.waitFor({ state: 'visible', timeout: 15000 });
    await postBtn.click();
    
  } finally {
    // if (page) await page.close().catch(() => {});
    // await closeBrowser();
  }
}


start().catch((err) => {
  console.error('Error in marketplace script:', err);
  process.exit(1);
});

async function closeBrowser() {
  if (browserContextPromise) {
    const context = await browserContextPromise;
    await context.close().catch(() => {});
    browserContextPromise = null;
  }
}