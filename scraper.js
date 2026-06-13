const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth');
const { gotoWithCaptcha, solveCaptchaIfPresent } = require('./captcha');

chromium.use(stealth());

const ROOT = path.join(__dirname, '.');
const USER_DATA_DIR = path.join(ROOT, 'browser-data');
const PAGE_DELAY_MS = Number(process.env.PAGE_DELAY_MS) || 1000;
const RACE_CAPTCHA_WAIT_MS = Number(process.env.RACE_CAPTCHA_WAIT_MS) || 2000;
const LISTING_CAPTCHA_WAIT_MS = Number(process.env.LISTING_CAPTCHA_WAIT_MS) || 8000;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

class ScrapeCancelledError extends Error {
    constructor() {
        super('Scrape cancelled');
        this.name = 'ScrapeCancelledError';
    }
}

let activePage = null;

function checkCancelled(signal) {
    if (signal?.aborted) throw new ScrapeCancelledError();
}

function cancelActiveScrape() {
    if (activePage) {
        activePage.close().catch(() => {});
        return true;
    }
    return false;
}

const BASE_URL = 'https://www.attheraces.com';
const COUNTRY_FILTERS = {
    uk: 'country-filters-filter-uk',
    ireland: 'country-filters-filter-eire',
};

function racecardsUrl(date) {
    return `${BASE_URL}/racecards/${date}`;
}

const SPLASH_SELECTOR = '.splash__bg.js-splash__trigger-close';
const MAX_SPLASH_RELOADS = 3;

async function isSplashPresent(page) {
    try {
        const count = await page.locator(SPLASH_SELECTOR).count();
        if (count === 0) return false;
        return await page.locator(SPLASH_SELECTOR).first().isVisible({ timeout: 500 });
    } catch {
        return false;
    }
}

/** Open a race URL (fast path like old.js) with captcha/splash handling only when needed. */
async function openRacePage(page, url, { onProgress } = {}) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await solveCaptchaIfPresent(page, { onProgress, waitMs: RACE_CAPTCHA_WAIT_MS });

    for (let attempt = 1; attempt <= MAX_SPLASH_RELOADS; attempt++) {
        if (!(await isSplashPresent(page))) return;

        console.log(
            `Splash overlay on race page, reloading (${attempt}/${MAX_SPLASH_RELOADS})…`
        );
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
        await solveCaptchaIfPresent(page, { onProgress, waitMs: RACE_CAPTCHA_WAIT_MS });
        await delay(500);
    }
}

/** Extract individual race URLs for UK and Ireland from the racecards listing page. */
async function extractUkIrelandRaceUrls(page) {
    await page.waitForSelector(
        '#fixtures-grouped-by-meeting .meeting-list-entry.country-filters-filter-uk, #fixtures-grouped-by-meeting .meeting-list-entry.country-filters-filter-eire',
        { state: 'attached', timeout: 30000 }
    );

    const paths = await page.evaluate((filters) => {
        const root =
            document.querySelector('#fixtures-grouped-by-meeting') ||
            document.querySelector('#country-filters-content-container');
        const countries = [filters.uk, filters.ireland];
        const urls = new Set();

        for (const countryClass of countries) {
            const entries = root.querySelectorAll(
                `.meeting-list-entry.${countryClass}`
            );
            for (const entry of entries) {
                const link = entry.querySelector('.post-text__t a[href^="/racecard/"]');
                if (link) urls.add(link.getAttribute('href'));
            }
        }

        return [...urls];
    }, COUNTRY_FILTERS);

    return paths
        .sort()
        .map((href) => `${BASE_URL}${href}`);
}

/** Extract full racecard details from the current race page. */
async function extractRacecardDetails(page, url) {
    await page.waitForSelector('.card-body .card-entry', {
        state: 'attached',
        timeout: 30000,
    });

    return page.evaluate((pageUrl) => {
        const clean = (el) =>
            el ? el.textContent.replace(/\s+/g, ' ').trim() : null;

        const pathParts = new URL(pageUrl).pathname.split('/').filter(Boolean);
        const [, course, date] = pathParts;

        const raceIdMatch = document.querySelector(
            'a[href*="/ajax/racecard/"]'
        )?.getAttribute('href');
        const raceId = raceIdMatch?.match(/\/ajax\/racecard\/(\d+)/)?.[1] ?? null;

        const runners = [...document.querySelectorAll('.card-body .card-entry')].map(
            (entry) => {
                const horseLink = entry.querySelector('.horse__link');
                let name = null;
                if (horseLink) {
                    const clone = horseLink.cloneNode(true);
                    clone.querySelectorAll('span').forEach((s) => s.remove());
                    name = clean(clone);
                }

                const starEl = entry.querySelector('.star-rating[class*="star-rating--"]');
                const starClass = starEl
                    ? [...starEl.classList].find(
                          (c) => /^star-rating--\d+$/.test(c)
                      )
                    : null;
                const starRating = starClass
                    ? Number(starClass.replace('star-rating--', ''))
                    : entry.dataset.starrating
                      ? Number(entry.dataset.starrating)
                      : null;

                return {
                    number: Number(entry.dataset.number) || null,
                    draw: Number(entry.dataset.draw) || null,
                    rating: entry.dataset.rating ? Number(entry.dataset.rating) : null,
                    starRating,
                    horse: {
                        name,
                        silk:
                            'https://www.attheraces.com' +
                                entry.querySelector('.horse__silk img')?.getAttribute('src') ||
                            null,
                    },
                    ageWeight: clean(entry.querySelector('.card-stats__age-weight')),
                    jockey: clean(
                        entry.querySelector('a[href*="/jockey/"] .icon-text__t')
                    ),
                    trainer: clean(
                        entry.querySelector('a[href*="/trainer/"] .icon-text__t')
                    ),
                };
            }
        );

        return {
            url: pageUrl,
            raceId,
            course: course || null,
            date: date || null,
            distance: clean(
                document.querySelector(
                    '.race-header__details--secondary > .p--large.font-weight--semibold'
                )
            ),
            total_runners: runners.length,
            runners,
        };
    }, url);
}

async function openUrlsOneByOne(page, urls, onProgress, signal, onRaceExtracted) {
    const races = [];

    for (let i = 0; i < urls.length; i++) {
        checkCancelled(signal);

        const url = urls[i];
        console.log(`[${i + 1}/${urls.length}] ${url}`);
        onProgress?.({ phase: 'race', current: i + 1, total: urls.length, url });

        await openRacePage(page, url, { onProgress });
        checkCancelled(signal);

        let raceEntry;
        try {
            raceEntry = await extractRacecardDetails(page, url);
        } catch (err) {
            if (err.name === 'ScrapeCancelledError') throw err;
            raceEntry = { url, error: err.message };
        }

        races.push(raceEntry);
        await onRaceExtracted?.(raceEntry, races);

        await delay(PAGE_DELAY_MS);
    }

    return races;
}

let browserContext = null;

async function getBrowserContext() {
    if (!browserContext) {
        browserContext = await chromium.launchPersistentContext(USER_DATA_DIR, {
            headless: false,
            args: ['--disable-blink-features=AutomationControlled'],
            viewport: { width: 1280, height: 900 },
        });
    }
    return browserContext;
}

async function scrapeForDate(date, { onProgress, signal, onRaceExtracted } = {}) {
    const context = await getBrowserContext();
    const page = await context.newPage();
    activePage = page;

    try {
        checkCancelled(signal);
        onProgress?.({ phase: 'listing', message: 'Loading racecards…' });
        await gotoWithCaptcha(page, racecardsUrl(date), {
            onProgress,
            waitMs: LISTING_CAPTCHA_WAIT_MS,
        });
        checkCancelled(signal);

        const raceUrls = await extractUkIrelandRaceUrls(page);
        onProgress?.({ phase: 'urls', total: raceUrls.length });
        checkCancelled(signal);

        if (raceUrls.length === 0) {
            return { date, races: [], raceCount: 0, runnerCount: 0 };
        }

        const races = await openUrlsOneByOne(
            page,
            raceUrls,
            onProgress,
            signal,
            onRaceExtracted
        );
        const runnerCount = races.reduce(
            (sum, r) => sum + (r.runners?.length ?? 0),
            0
        );

        return { date, races, raceCount: races.length, runnerCount };
    } finally {
        await page.close().catch(() => {});
        if (activePage === page) activePage = null;
    }
}

function escapeCsv(val) {
    if (val == null) return '';
    const s = String(val);
    if (s.includes(',') || s.includes('"') || s.includes('\n')) {
        return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
}

function racesToCsv(races) {
    const headers = [
        'course',
        'date',
        'distance',
        'raceId',
        'url',
        'number',
        'draw',
        'rating',
        'starRating',
        'horse',
        'silk',
        'ageWeight',
        'jockey',
        'trainer',
    ];
    const rows = [headers.join(',')];

    for (const race of races) {
        if (race.error) continue;
        for (const runner of race.runners || []) {
            rows.push(
                [
                    race.course,
                    race.date,
                    race.distance,
                    race.raceId,
                    race.url,
                    runner.number,
                    runner.draw,
                    runner.rating,
                    runner.starRating,
                    runner.horse?.name,
                    runner.horse?.silk,
                    runner.ageWeight,
                    runner.jockey,
                    runner.trainer,
                ]
                    .map(escapeCsv)
                    .join(',')
            );
        }
    }

    return rows.join('\n');
}

module.exports = {
    racecardsUrl,
    scrapeForDate,
    racesToCsv,
    cancelActiveScrape,
    ScrapeCancelledError,
};
