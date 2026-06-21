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
const UK_COUNTRY_FILTER = 'country-filters-filter-uk';
const JUMPS_RACE_RE =
    /hurdle|chase|bumper|nh flat|nhf|steeplechase|national hunt|hunters'/i;

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

/** True when the page shows post-race results instead of a pre-race racecard. */
async function isFinishedRacePage(page) {
    return page.evaluate(() => {
        if (document.querySelector('.card-body .card-entry[data-number]')) {
            return false;
        }

        const headerText =
            document.querySelector('#tab-full-result .card-header')?.textContent ||
            document.querySelector('.card__content .card-wrapper .card-header')
                ?.textContent ||
            '';

        return (
            headerText.includes('Position') && headerText.includes('Dist Btn')
        );
    });
}

/** True when the page is a jumps race rather than UK flat. */
async function isJumpsRacePage(page) {
    return page.evaluate((jumpsPattern) => {
        const headerText = [
            document.querySelector('.race-header__details--primary')?.textContent,
            document.querySelector('.race-header__title')?.textContent,
            document.querySelector('.race-header h1')?.textContent,
        ]
            .filter(Boolean)
            .join(' ');

        return new RegExp(jumpsPattern, 'i').test(headerText);
    }, JUMPS_RACE_RE.source);
}

/** Extract upcoming UK flat race URLs from the racecards listing page. */
async function extractUkFlatRaceUrls(page) {
    await page.waitForSelector(
        `#fixtures-grouped-by-meeting .meeting-list-entry.${UK_COUNTRY_FILTER}`,
        { state: 'attached', timeout: 30000 }
    );

    const paths = await page.evaluate(
        ({ ukCountryClass, jumpsPattern }) => {
            const root =
                document.querySelector('#fixtures-grouped-by-meeting') ||
                document.querySelector('#country-filters-content-container');
            const urls = new Set();
            const jumpsRe = new RegExp(jumpsPattern, 'i');

            for (const entry of root.querySelectorAll(
                `.meeting-list-entry.${ukCountryClass}`
            )) {
                const link = entry.querySelector(
                    '.post-text__t a[href^="/racecard/"]'
                );
                if (!link) continue;

                const entryText = entry.textContent || '';

                // Finished races are shown in red and include "- X ran" on the listing.
                if (link.classList.contains('text-color--red')) continue;
                if (/-\s*\d+\s+ran\b/i.test(entryText)) continue;
                if (jumpsRe.test(entryText)) continue;

                urls.add(link.getAttribute('href'));
            }

            return [...urls];
        },
        { ukCountryClass: UK_COUNTRY_FILTER, jumpsPattern: JUMPS_RACE_RE.source }
    );

    return paths
        .sort()
        .map((href) => `${BASE_URL}${href}`);
}

/** Extract pre-race racecard details from the current race page. */
async function extractRacecardDetails(page, url) {
    await page.waitForSelector('.card-body .card-entry[data-number]', {
        state: 'attached',
        timeout: 30000,
    });
    await page
        .waitForSelector('.odds-grid__row--horse', {
            state: 'attached',
            timeout: 10000,
        })
        .catch(() => {});

    return page.evaluate((pageUrl) => {
        const clean = (el) =>
            el ? el.textContent.replace(/\s+/g, ' ').trim() : null;

        const pathParts = new URL(pageUrl).pathname.split('/').filter(Boolean);
        const [, course, date, timeSegment] = pathParts;

        const parseRaceTime = () => {
            const headerTime = document
                .querySelector('.race-header__details--primary h2 b')
                ?.textContent?.trim();
            if (headerTime && /^\d{1,2}:\d{2}$/.test(headerTime)) {
                return headerTime;
            }
            if (timeSegment && /^\d{4}$/.test(timeSegment)) {
                return `${timeSegment.slice(0, 2)}:${timeSegment.slice(2)}`;
            }
            return headerTime || null;
        };

        const raceIdMatch = document.querySelector(
            'a[href*="/ajax/racecard/"]'
        )?.getAttribute('href');
        const raceId = raceIdMatch?.match(/\/ajax\/racecard\/(\d+)/)?.[1] ?? null;

        const parseLastRunPosition = (form) => {
            if (!form) return null;
            const trimmed = form.replace(/-+$/, '');
            const lastChar = trimmed.slice(-1);
            if (/[0-9]/.test(lastChar)) return Number(lastChar);
            return null;
        };

        const isValidFormString = (form) => {
            if (!form) return false;
            if (!/\d/.test(form)) return false;
            return /^[0-9/\-PUFRCDBS]+$/i.test(form);
        };

        const parseHorseName = (horseLink) => {
            if (!horseLink) return null;
            const clone = horseLink.cloneNode(true);
            clone.querySelectorAll('span').forEach((s) => s.remove());
            return clean(clone);
        };

        const parseSilk = (entry) => {
            const src = entry.querySelector('.horse__silk img')?.getAttribute('src');
            return src ? `https://www.attheraces.com${src}` : null;
        };

        const parseOfficialRatingFromPill = (orText) => {
            if (orText && orText !== '-' && !orText.includes('\u00a0')) {
                const n = Number(orText);
                return Number.isFinite(n) ? n : null;
            }
            return null;
        };

        const parseForm = (entry) => {
            const el = entry.querySelector('.card-form .card-form__stats');
            if (!el) return null;
            const form = el.innerText.replace(/\s+/g, '').trim();
            return isValidFormString(form) ? form : null;
        };

        const parseHorseId = (horseLink) => {
            const href = horseLink?.getAttribute('href') || '';
            return href.match(/\/(\d+)(?:\?|$)/)?.[1] ?? null;
        };

        const fractionToDecimal = (fraction) => {
            if (!fraction) return null;
            const normalised = fraction.trim().toLowerCase();
            if (normalised === 'sp' || normalised === 'nr' || normalised === '-') {
                return null;
            }
            if (normalised === 'evs' || normalised === 'evens') return 2;
            const match = normalised.match(/^(\d+)\s*\/\s*(\d+)$/);
            if (!match) return null;
            return Number(match[1]) / Number(match[2]) + 1;
        };

        const pickBestFractionalOdds = (fractions) => {
            const prices = [...new Set(fractions.map((f) => f.trim()).filter(Boolean))];
            const available = prices.filter(
                (price) => price !== 'SP' && price !== '-' && price !== 'N/A'
            );
            if (available.length === 0) {
                return prices.includes('SP') ? 'SP' : null;
            }
            return available.sort(
                (a, b) => (fractionToDecimal(b) ?? 0) - (fractionToDecimal(a) ?? 0)
            )[0];
        };

        const buildOddsByHorseId = () => {
            const oddsByHorseId = new Map();
            for (const row of document.querySelectorAll('.odds-grid__row--horse')) {
                const horseId = row.id?.replace(/^row-/, '');
                if (!horseId) continue;
                const fractions = [
                    ...row.querySelectorAll('.odds-value--fraction'),
                ].map((el) => el.textContent.trim());
                oddsByHorseId.set(horseId, pickBestFractionalOdds(fractions));
            }
            return oddsByHorseId;
        };

        const parseOdds = (entry, oddsByHorseId) => {
            const horseId = parseHorseId(entry.querySelector('.horse__link'));
            if (!horseId) return null;
            return oddsByHorseId.get(horseId) ?? null;
        };

        const parseDaysSinceLastRun = (entry) => {
            for (const span of entry.querySelectorAll(
                '.horse__details > .p--x-small'
            )) {
                if (span.closest('.horse__link')) continue;
                const text = span.textContent.trim();
                if (/^\d+$/.test(text)) return Number(text);
            }
            return null;
        };

        const isNonRunner = (entry) => {
            const draw = Number(entry.dataset.draw);
            if (draw === 999) return true;
            const silk =
                entry.querySelector('.horse__silk img')?.getAttribute('src') ||
                '';
            return /nonrunner/i.test(silk);
        };

        const hasRequiredRunnerFields = (runner) =>
            runner.draw != null &&
            runner.rating != null &&
            runner.form &&
            runner.lastRunPosition != null &&
            runner.daysSinceLastRun != null;

        const parseDatasetNumber = (value) => {
            if (value === undefined || value === '') return null;
            const n = Number(value);
            return Number.isFinite(n) ? n : null;
        };

        const parseGoing = () => {
            const goingEl = document.querySelector(
                '.race-header__details--secondary p.p--medium'
            );
            if (!goingEl) return null;
            const going = goingEl.innerText.replace(/\s+/g, ' ').trim();
            return going || null;
        };

        const parseRaceType = () => {
            const primary = document.querySelector(
                '.race-header__details--primary'
            );
            if (!primary) return null;

            const title =
                primary.querySelector('p.p--medium b')?.textContent?.trim() ||
                '';
            const metaLine = [...primary.querySelectorAll('p')]
                .map((p) => p.textContent.replace(/\s+/g, ' ').trim())
                .find((text) => /\bClass\s*\d+\b|\bGroup\s*\d+\b/i.test(text));
            const combined = `${title} ${metaLine || ''}`;
            const parts = [];

            const group = combined.match(/\bGroup\s*\d+\b/i)?.[0];
            const raceClass = combined.match(/\bClass\s*\d+\b/i)?.[0];
            if (group) parts.push(group.replace(/\s+/g, ' '));
            if (raceClass) parts.push(raceClass.replace(/\s+/g, ' '));

            const categories = [
                'Handicap',
                'Maiden',
                'Novice',
                'Listed',
                'Stakes',
                'Plate',
                'Cup',
                'Selling',
                'Claiming',
                'Auction',
            ];
            for (const category of categories) {
                if (new RegExp(`\\b${category}\\b`, 'i').test(title)) {
                    parts.push(category);
                    break;
                }
            }

            if (parts.length > 0) {
                return [...new Set(parts)].join(' ');
            }

            return metaLine || title || null;
        };

        const cardWrapper =
            document.querySelector('.card__content .card-wrapper') ||
            document.querySelector('.card-wrapper');
        const oddsByHorseId = buildOddsByHorseId();
        const runners = [
            ...(cardWrapper?.querySelectorAll('.card-body .card-entry') || []),
        ]
            .filter((entry) => !isNonRunner(entry))
            .map((entry) => {
                const horseLink = entry.querySelector('.horse__link');
                const form = parseForm(entry);

                return {
                    number: parseDatasetNumber(entry.dataset.number),
                    draw: parseDatasetNumber(entry.dataset.draw),
                    rating: parseOfficialRatingFromPill(
                        clean(entry.querySelector('.card-stats__or .text-pill'))
                    ),
                    odds: parseOdds(entry, oddsByHorseId),
                    form,
                    lastRunPosition: parseLastRunPosition(form),
                    daysSinceLastRun: parseDaysSinceLastRun(entry),
                    horse: {
                        name: parseHorseName(horseLink),
                        silk: parseSilk(entry),
                    },
                    ageWeight: clean(
                        entry.querySelector('.card-stats__age-weight')
                    ),
                    jockey: clean(
                        entry.querySelector('a[href*="/jockey/"] .icon-text__t')
                    ),
                    trainer: clean(
                        entry.querySelector('a[href*="/trainer/"] .icon-text__t')
                    ),
                };
            })
            .filter(hasRequiredRunnerFields);

        return {
            url: pageUrl,
            raceId,
            course: course || null,
            date: date || null,
            time: parseRaceTime(),
            distance: clean(
                document.querySelector(
                    '.race-header__details--secondary > .p--large.font-weight--semibold'
                )
            ),
            going: parseGoing(),
            raceType: parseRaceType(),
            total_runners: runners.length,
            runners,
        };
    }, url);
}

async function openUrlsOneByOne(page, urls, onProgress, signal, onRaceExtracted) {
    const races = [];
    let skippedFinished = 0;
    let skippedJumps = 0;
    let skippedEmpty = 0;

    for (let i = 0; i < urls.length; i++) {
        checkCancelled(signal);

        const url = urls[i];
        console.log(`[${i + 1}/${urls.length}] ${url}`);
        onProgress?.({ phase: 'race', current: i + 1, total: urls.length, url });

        await openRacePage(page, url, { onProgress });
        checkCancelled(signal);

        await page.waitForSelector('.card-body .card-entry', {
            state: 'attached',
            timeout: 30000,
        });

        if (await isFinishedRacePage(page)) {
            skippedFinished += 1;
            console.log(`  Skipping finished race`);
            await delay(PAGE_DELAY_MS);
            continue;
        }

        if (await isJumpsRacePage(page)) {
            skippedJumps += 1;
            console.log(`  Skipping jumps race`);
            await delay(PAGE_DELAY_MS);
            continue;
        }

        let raceEntry;
        try {
            raceEntry = await extractRacecardDetails(page, url);
        } catch (err) {
            if (err.name === 'ScrapeCancelledError') throw err;
            raceEntry = { url, error: err.message };
        }

        // if (!raceEntry.error && !(raceEntry.runners?.length > 0)) {
        //     skippedEmpty += 1;
        //     console.log(`  Skipping race with no valid runners`);
        //     await delay(PAGE_DELAY_MS);
        //     continue;
        // }

        races.push(raceEntry);
        await onRaceExtracted?.(raceEntry, races);

        await delay(PAGE_DELAY_MS);
    }

    if (skippedFinished > 0) {
        console.log(`Skipped ${skippedFinished} finished race(s)`);
    }
    if (skippedJumps > 0) {
        console.log(`Skipped ${skippedJumps} jumps race(s)`);
    }
    if (skippedEmpty > 0) {
        console.log(`Skipped ${skippedEmpty} race(s) with no valid runners`);
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

        const raceUrls = await extractUkFlatRaceUrls(page);
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

/** Force spreadsheet apps to treat a value as text (avoids form like 4951-08 becoming a date). */
function escapeCsvText(val) {
    if (val == null) return '';
    const s = String(val);
    return `"=""${s.replace(/"/g, '""')}"""`;
}

function racesToCsv(races) {
    const headers = [
        'course',
        'date',
        'time',
        'going',
        'raceType',
        'distance',
        'raceId',
        'url',
        'number',
        'draw',
        'rating',
        'odds',
        'form',
        'lastRunPosition',
        'daysSinceLastRun',
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
            const values = [
                race.course,
                race.date,
                race.time,
                race.going,
                race.raceType,
                race.distance,
                race.raceId,
                race.url,
                runner.number,
                runner.draw,
                runner.rating,
                runner.odds,
                runner.form,
                runner.lastRunPosition,
                runner.daysSinceLastRun,
                runner.horse?.name,
                runner.horse?.silk,
                runner.ageWeight,
                runner.jockey,
                runner.trainer,
            ];
            rows.push(
                values
                    .map((val, index) =>
                        headers[index] === 'form' ? escapeCsvText(val) : escapeCsv(val)
                    )
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
