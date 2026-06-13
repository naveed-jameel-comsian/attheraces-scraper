const path = require('path');
const { Solver } = require('@2captcha/captcha-solver');

require('dotenv').config({ path: path.join(__dirname, '.env') });

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const CAPTCHA_SELECTORS = {
    image: '#captchaImage',
    input: '#capInput',
    submit: '#capSubmit',
    error: '#errorContainer',
    form: '#capForm',
};

const MAX_ATTEMPTS = 8;
const CAPTCHA_POLL_MS = 300;

let solver = null;

function getTwoCaptchaApiKey() {
    return (
        process.env.TWOCAPTCHA_API_KEY ||
        process.env.TWO_CAPTCHA_API_KEY ||
        process.env.CAPTCHA_2_API_KEY ||
        ''
    ).trim();
}

function getSolver() {
    const apiKey = getTwoCaptchaApiKey();
    if (!apiKey) {
        throw new Error(
            'TWOCAPTCHA_API_KEY is not set. Copy .env.example to .env and add your 2captcha API key.'
        );
    }
    if (!solver) {
        solver = new Solver(apiKey, 3000);
    }
    return solver;
}

function normalizeAnswer(text) {
    return (text || '')
        .replace(/\s/g, '')
        .replace(/[^A-Za-z0-9]/g, '')
        .trim();
}

function toBase64Body(dataUrl) {
    const match = dataUrl.match(/^data:image\/\w+;base64,(.+)$/);
    return match ? match[1] : dataUrl;
}

async function solveImageWith2Captcha(dataUrl) {
    const body = toBase64Body(dataUrl);
    if (!body) return { answer: '', id: null };

    console.log('[captcha] Sending image to 2captcha…');
    const result = await getSolver().imageCaptcha({
        body,
        regsense: 1,
        min_len: 4,
        max_len: 10,
    });

    const answer = normalizeAnswer(result.data);
    console.log(`[captcha] 2captcha answer: ${answer}`);
    return { answer, id: result.id ?? null };
}

/** Find page or frame that contains the Fastly captcha form. */
async function findCaptchaContext(page) {
    const hasCaptcha = async (ctx) => {
        const count = await ctx
            .locator(`${CAPTCHA_SELECTORS.image}, ${CAPTCHA_SELECTORS.form}`)
            .count();
        return count > 0;
    };

    if (await hasCaptcha(page)) return page;

    for (const frame of page.frames()) {
        if (frame === page.mainFrame()) continue;
        if (await hasCaptcha(frame).catch(() => false)) return frame;
    }

    return null;
}

async function getReadyCaptchaContext(page) {
    const ctx = await findCaptchaContext(page);
    if (!ctx) return null;

    const src = await ctx
        .locator(CAPTCHA_SELECTORS.image)
        .getAttribute('src')
        .catch(() => null);
    return src?.startsWith('data:image') ? ctx : null;
}

/** Wait briefly for captcha to appear; returns immediately when none is found. */
async function waitForCaptchaContext(page, timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        const ctx = await getReadyCaptchaContext(page);
        if (ctx) return ctx;
        await delay(CAPTCHA_POLL_MS);
    }

    return null;
}

async function isCaptchaPresent(page) {
    return !!(await getReadyCaptchaContext(page));
}

async function waitForCaptchaOutcome(ctx, previousSrc) {
    const errorLocator = ctx.locator(
        `${CAPTCHA_SELECTORS.error}[aria-hidden="false"]`
    );
    const imageLocator = ctx.locator(CAPTCHA_SELECTORS.image);

    for (let i = 0; i < 20; i++) {
        const imageCount = await imageLocator.count();
        if (imageCount === 0) return 'passed';

        if (await errorLocator.isVisible().catch(() => false)) {
            return 'failed';
        }

        const currentSrc = await imageLocator.getAttribute('src').catch(() => null);
        if (currentSrc && previousSrc && currentSrc !== previousSrc) {
            const errorVisible = await errorLocator.isVisible().catch(() => false);
            if (errorVisible) return 'failed';
        }

        await delay(300);
    }

    return (await imageLocator.count()) > 0 ? 'failed' : 'passed';
}

async function reportBadCaptcha(captchaId) {
    if (!captchaId || !solver) return;
    try {
        await solver.badReport(captchaId);
        console.log('[captcha] Reported incorrect answer to 2captcha');
    } catch (err) {
        console.warn('[captcha] badReport failed:', err.message);
    }
}

async function solveCaptchaIfPresent(page, { onProgress, waitMs = 3000 } = {}) {
    const ctx = await waitForCaptchaContext(page, waitMs);
    if (!ctx) return false;

    onProgress?.({ phase: 'captcha', message: 'Solving CAPTCHA via 2captcha…' });
    console.log('[captcha] CAPTCHA detected, using 2captcha…');

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        const activeCtx = await getReadyCaptchaContext(page);
        if (!activeCtx) return true;

        const imageLocator = activeCtx.locator(CAPTCHA_SELECTORS.image);
        const src = await imageLocator.getAttribute('src');
        if (!src?.startsWith('data:image')) {
            await delay(300);
            continue;
        }

        onProgress?.({
            phase: 'captcha',
            message: `2captcha attempt ${attempt}/${MAX_ATTEMPTS}…`,
            attempt,
        });

        let captchaId = null;
        let answer = '';

        try {
            const solved = await solveImageWith2Captcha(src);
            answer = solved.answer;
            captchaId = solved.id;
        } catch (err) {
            console.error(`[captcha] 2captcha error (attempt ${attempt}):`, err.message);
            await delay(1000);
            continue;
        }

        if (!answer) {
            console.log(`[captcha] Empty answer on attempt ${attempt}, retrying…`);
            await delay(500);
            continue;
        }

        console.log(`[captcha] Submitting attempt ${attempt}: "${answer}"`);

        const input = activeCtx.locator(CAPTCHA_SELECTORS.input);
        await input.fill('');
        await input.fill(answer);

        const navigation = page
            .waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 })
            .catch(() => null);
        await activeCtx.locator(CAPTCHA_SELECTORS.submit).click();
        await navigation;

        const outcome = await waitForCaptchaOutcome(activeCtx, src);
        if (outcome === 'passed') {
            onProgress?.({ phase: 'captcha', message: 'CAPTCHA solved.' });
            console.log('[captcha] CAPTCHA solved.');
            await delay(500);
            return true;
        }

        console.log(`[captcha] Attempt ${attempt} rejected, retrying…`);
        await reportBadCaptcha(captchaId);
        await activeCtx.locator(CAPTCHA_SELECTORS.input).fill('').catch(() => {});
        await delay(800);
    }

    throw new Error(`CAPTCHA not solved after ${MAX_ATTEMPTS} attempts`);
}

async function gotoWithCaptcha(page, url, options = {}) {
    const { onProgress, waitMs = 8000, ...gotoOpts } = options;
    await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: 60000,
        ...gotoOpts,
    });
    await solveCaptchaIfPresent(page, { onProgress, waitMs });
}

async function ensureNoCaptcha(page, { onProgress, waitMs = 2000 } = {}) {
    if (await isCaptchaPresent(page)) {
        await solveCaptchaIfPresent(page, { onProgress, waitMs });
    }
}

module.exports = {
    solveCaptchaIfPresent,
    gotoWithCaptcha,
    ensureNoCaptcha,
    isCaptchaPresent,
};
