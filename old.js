const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth');
chromium.use(stealth());

const ROOT = path.join(__dirname, '.');
const USER_DATA_DIR = path.join(ROOT, 'browser-data');
const RACE_URLS_FILE = path.join(ROOT, 'race-urls.json');
const RACE_DETAILS_FILE = path.join(ROOT, 'race-details.json');
const PAGE_DELAY_MS = 3000;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const BASE_URL = 'https://www.attheraces.com';
const COUNTRY_FILTERS = {
    uk: 'country-filters-filter-uk',
    ireland: 'country-filters-filter-eire',
};

/** Extract individual race URLs for UK and Ireland from the racecards listing page. */
async function extractUkIrelandRaceUrls(page) {
    // Grouped-by-meeting panel is visible; chronological panel is hidden but still in the DOM.
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

function saveRaceUrls(urls) {
    fs.writeFileSync(
        RACE_URLS_FILE,
        JSON.stringify({ scrapedAt: new Date().toISOString(), urls }, null, 2),
        'utf8'
    );
    console.log(`Saved ${urls.length} URLs to ${RACE_URLS_FILE}`);
}

function saveRaceDetails(races) {
    fs.writeFileSync(
        RACE_DETAILS_FILE,
        JSON.stringify({ scrapedAt: new Date().toISOString(), races }, null, 2),
        'utf8'
    );
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
        const [, course, date, time] = pathParts;

        const raceIdMatch = document.querySelector(
            'a[href*="/ajax/racecard/"]'
        )?.getAttribute('href');
        const raceId = raceIdMatch?.match(/\/ajax\/racecard\/(\d+)/)?.[1] ?? null;

        const titleEl =
            document.querySelector('.race-header h1, .racecard-header h1, h1.h2') ||
            document.querySelector('h1');
        const title = clean(titleEl);

        const metaText = clean(
            document.querySelector('.race-header, .racecard-header, .race-header__meta')
        );
        const pickMeta = (label) => {
            const re = new RegExp(`${label}:\\s*([^\\n|]+)`, 'i');
            return metaText?.match(re)?.[1]?.trim() ?? null;
        };

        const forecastEl = document.querySelector('#forecast');
        const forecast = forecastEl ? clean(forecastEl) : null;

        const lastUpdated = [...document.querySelectorAll('.card-footer__content p')]
            .map((p) => clean(p))
            .find((t) => t && t.startsWith('Last Updated:'));

        const parseStatsTable = (root) => {
            if (!root) return [];
            const table = root.querySelector('table');
            if (!table) return [];

            return [...table.querySelectorAll('tr')].map((tr) => {
                const cells = [...tr.querySelectorAll('th, td')].map((c) => clean(c));
                return cells.filter(Boolean).length ? cells : null;
            }).filter(Boolean);
        };

        const runners = [...document.querySelectorAll('.card-body .card-entry')].map(
            (entry) => {
                const tooltipId = entry
                    .querySelector('[id^="tooltip-atr-verdict-content-"]')
                    ?.id?.replace('tooltip-atr-verdict-content-', '');

                const horseLink = entry.querySelector('.horse__link');
                let name = null;
                let country = null;
                if (horseLink) {
                    const countrySpan = horseLink.querySelector('span.p--x-small');
                    country = countrySpan
                        ? clean(countrySpan).replace(/[()]/g, '')
                        : null;
                    const clone = horseLink.cloneNode(true);
                    clone.querySelectorAll('span').forEach((s) => s.remove());
                    name = clean(clone);
                }

                const officialRatingBadge = [
                    ...entry.querySelectorAll('.horse__details .p--x-small'),
                ]
                    .map((el) => clean(el))
                    .find((t) => t && /^\d+$/.test(t));

                const expertBlock = entry.querySelector('.card-cell-timeform p');
                let expertView = clean(expertBlock);
                if (expertBlock) {
                    const clone = expertBlock.cloneNode(true);
                    clone.querySelector('.star-rating')?.remove();
                    expertView = clean(clone);
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

                const orText = clean(entry.querySelector('.card-stats__or .text-pill'));
                const officialRating =
                    orText && orText !== '-' && !orText.includes('\u00a0')
                        ? orText
                        : officialRatingBadge ?? null;

                return {
                    number: Number(entry.dataset.number) || null,
                    draw: Number(entry.dataset.draw) || null,
                    rating: entry.dataset.rating ? Number(entry.dataset.rating) : null,
                    starRating,
                    // formFigure: clean(entry.querySelector('.card-form__stats')) || null,
                    horse: {
                        // id: tooltipId,
                        name,
                        // country,
                        // pedigree: clean(entry.querySelector('.horse__desc')),
                        silk: "https://www.attheraces.com" + entry.querySelector('.horse__silk img')?.getAttribute('src') || null,
                        // formUrl: horseLink?.getAttribute('href') || null,
                        // icons: [...entry.querySelectorAll('.horse__icons .text-pill')].map(
                        //     (el) => clean(el)
                        // ),
                    },
                    ageWeight: clean(entry.querySelector('.card-stats__age-weight')),
                    // officialRating,
                    jockey: clean(
                        entry.querySelector('a[href*="/jockey/"] .icon-text__t')
                    ),
                    trainer: clean(
                        entry.querySelector('a[href*="/trainer/"] .icon-text__t')
                    ),
                    // timeformRating:
                    //     clean(
                    //         entry.querySelector(
                    //             '.card-cell--timeform .text-pill.text-pill--outlined'
                    //         )
                    //     ) || (entry.dataset.rating ? String(entry.dataset.rating) : null),
                    // expertView,
                    // atrVerdict: clean(
                    //     document.querySelector(`#tooltip-atr-verdict-content-${tooltipId} p`)
                    // ),
                    // timeformVerdict: clean(
                    //     document.querySelector(
                    //         `#tooltip-timeform-verdict-content-${tooltipId} p`
                    //     )
                    // ),
                    // stats: parseStatsTable(
                    //     document.querySelector(`#tooltip-atr-horse-attributes-${tooltipId}`)
                    // ),
                };
            }
        );

        return {
            url: pageUrl,
            raceId,
            course: course || null,
            date: date || null,
            // time: time || null,
            // title,
            // going: pickMeta('Going'),
            // weather: pickMeta('Weather'),
            distance: pickMeta('Distance') || pickMeta('Dist'),
            // raceClass: pickMeta('Class'),
            // fieldSize: pickMeta('Runners') || pickMeta('Run'),
            // forecast,
            // lastUpdated,
            total_runners: runners.length,
            runners,
        };
    }, url);
}

async function openUrlsOneByOne(page, urls) {
    const races = [];

    for (let i = 0; i < urls.length; i++) {
        const url = urls[i];
        console.log(`[${i + 1}/${urls.length}] ${url}`);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

        try {
            const details = await extractRacecardDetails(page, url);
            races.push(details);
            saveRaceDetails(races);
            console.log(
                `  saved ${details.runners.length} runners -> ${RACE_DETAILS_FILE}`
            );
        } catch (err) {
            console.error(`  failed to scrape ${url}:`, err.message);
            races.push({ url, error: err.message });
            saveRaceDetails(races);
        }

        await delay(PAGE_DELAY_MS);
    }

    console.log(`Done. ${races.length} races written to ${RACE_DETAILS_FILE}`);
}

async function main() {
    const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
        headless: false,
        args: ['--disable-blink-features=AutomationControlled'],
        viewport: { width: 1280, height: 900 },
    });
    const page = await context.newPage();

    await page.goto(`${BASE_URL}/racecards`, {
        waitUntil: 'domcontentloaded',
        timeout: 60000,
    });
    await delay(4000);

    const raceUrls = await extractUkIrelandRaceUrls(page);
    saveRaceUrls(raceUrls);
    await openUrlsOneByOne(page, raceUrls);

    // await context.close().catch(() => {});
}

main();