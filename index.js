const fs = require('fs');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '.env') });
const express = require('express');
const cors = require('cors');
const { scrapeForDate, racesToCsv, cancelActiveScrape } = require('./scraper');

const ROOT = path.join(__dirname, '.');
const DATA_DIR = path.join(ROOT, 'data');
const RESULTS_DIR = path.join(DATA_DIR, 'results');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');

const PORT = process.env.PORT || 3000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function ensureDataDirs() {
    fs.mkdirSync(RESULTS_DIR, { recursive: true });
    if (!fs.existsSync(HISTORY_FILE)) {
        fs.writeFileSync(HISTORY_FILE, JSON.stringify({ searches: [] }, null, 2));
    }
}

function readHistory() {
    ensureDataDirs();
    return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
}

function writeHistory(data) {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function resultPath(date) {
    return path.join(RESULTS_DIR, `${date}.json`);
}

function readResult(date) {
    const file = resultPath(date);
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function saveResult(date, payload) {
    fs.writeFileSync(
        resultPath(date),
        JSON.stringify({ scrapedAt: new Date().toISOString(), ...payload }, null, 2),
        'utf8'
    );
}

function upsertHistoryEntry(entry) {
    const history = readHistory();
    const idx = history.searches.findIndex((s) => s.date === entry.date);
    if (idx >= 0) {
        history.searches[idx] = { ...history.searches[idx], ...entry };
    } else {
        history.searches.unshift(entry);
    }
    writeHistory(history);
    return entry;
}

let activeJob = null;
let activeAbortController = null;

function stopActiveJob() {
    if (!activeJob) return false;
    activeAbortController?.abort();
    cancelActiveScrape();
    return true;
}

function clearAllHistory() {
    writeHistory({ searches: [] });
    if (fs.existsSync(RESULTS_DIR)) {
        for (const file of fs.readdirSync(RESULTS_DIR)) {
            if (file.endsWith('.json')) {
                fs.unlinkSync(path.join(RESULTS_DIR, file));
            }
        }
    }
}

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(ROOT, 'public')));

app.get('/api/history', (_req, res) => {
    const { searches } = readHistory();
    res.json({ searches });
});

app.get('/api/scrape/:date/status', (req, res) => {
    const { date } = req.params;
    if (!DATE_RE.test(date)) {
        return res.status(400).json({ error: 'Invalid date. Use YYYY-MM-DD.' });
    }

    if (activeJob?.date === date) {
        return res.json(activeJob);
    }

    const entry = readHistory().searches.find((s) => s.date === date);
    if (entry) return res.json(entry);

    res.status(404).json({ error: 'No scrape found for this date.' });
});

app.post('/api/scrape', async (req, res) => {
    const date = req.body?.date?.trim();
    if (!date || !DATE_RE.test(date)) {
        return res.status(400).json({ error: 'Invalid date. Use YYYY-MM-DD.' });
    }

    if (activeJob) {
        return res.status(409).json({
            error: 'A scrape is already running.',
            activeDate: activeJob.date,
        });
    }

    const existing = readHistory().searches.find(
        (s) => s.date === date && s.status === 'running'
    );
    if (existing) {
        return res.status(409).json({ error: 'This date is already being scraped.' });
    }

    const startedAt = new Date().toISOString();
    const abortController = new AbortController();
    activeAbortController = abortController;
    activeJob = {
        date,
        status: 'running',
        startedAt,
        progress: { phase: 'starting', message: 'Starting…' },
        raceCount: 0,
        runnerCount: 0,
    };
    upsertHistoryEntry(activeJob);

    saveResult(date, { date, races: [], raceCount: 0, runnerCount: 0 });

    res.json({ ok: true, date, status: 'running' });

    try {
        const result = await scrapeForDate(date, {
            signal: abortController.signal,
            onProgress: (progress) => {
                if (!activeJob) return;
                activeJob.progress = progress;
                if (progress.total != null) activeJob.raceCount = progress.total;
            },
            onRaceExtracted: (race, races) => {
                const runnerCount = races.reduce(
                    (sum, r) => sum + (r.runners?.length ?? 0),
                    0
                );
                saveResult(date, {
                    date,
                    races,
                    // raceCount: races.length,
                    // runnerCount,
                });
                if (activeJob) {
                    activeJob.runnerCount = runnerCount;
                }
                const label = race.course
                    ? `${race.course} (${race.date || date})`
                    : race.url;
                console.log(
                    `  [${races.length}] saved ${label} -> ${resultPath(date)}`
                );
            },
        });

        if (abortController.signal.aborted) return;

        saveResult(date, result);

        const completed = {
            date,
            status: 'completed',
            startedAt,
            completedAt: new Date().toISOString(),
            raceCount: result.raceCount,
            runnerCount: result.runnerCount,
            progress: null,
        };
        upsertHistoryEntry(completed);
    } catch (err) {
        if (
            abortController.signal.aborted ||
            err.name === 'ScrapeCancelledError'
        ) {
            upsertHistoryEntry({
                date,
                status: 'cancelled',
                startedAt,
                completedAt: new Date().toISOString(),
                error: 'Cancelled by user',
                progress: null,
            });
        } else {
            console.error(`Scrape failed for ${date}:`, err);
            upsertHistoryEntry({
                date,
                status: 'failed',
                startedAt,
                completedAt: new Date().toISOString(),
                error: err.message,
                progress: null,
            });
        }
    } finally {
        activeJob = null;
        activeAbortController = null;
    }
});

app.post('/api/job/stop', (_req, res) => {
    if (!activeJob) {
        return res.status(404).json({ error: 'No running job.' });
    }

    const { date } = activeJob;
    stopActiveJob();
    res.json({ ok: true, date, status: 'cancelling' });
});

app.delete('/api/history', (_req, res) => {
    const hadJob = stopActiveJob();
    clearAllHistory();
    activeJob = null;
    activeAbortController = null;
    res.json({ ok: true, stoppedJob: hadJob });
});

app.get('/api/results/:date', (req, res) => {
    const { date } = req.params;
    if (!DATE_RE.test(date)) {
        return res.status(400).json({ error: 'Invalid date. Use YYYY-MM-DD.' });
    }

    const result = readResult(date);
    if (!result) {
        return res.status(404).json({ error: 'No results for this date.' });
    }

    res.json(result);
});

app.get('/api/download/:date.csv', (req, res) => {
    const { date } = req.params;
    if (!DATE_RE.test(date)) {
        return res.status(400).json({ error: 'Invalid date. Use YYYY-MM-DD.' });
    }

    const result = readResult(date);
    if (!result?.races?.length) {
        return res.status(404).json({ error: 'No results to download for this date.' });
    }

    const csv = racesToCsv(result.races);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
        'Content-Disposition',
        `attachment; filename="attheraces-${date}.csv"`
    );
    res.send(csv);
});

ensureDataDirs();

const twocaptchaKey = (
    process.env.TWOCAPTCHA_API_KEY ||
    process.env.TWO_CAPTCHA_API_KEY ||
    process.env.CAPTCHA_2_API_KEY ||
    ''
).trim();
if (!twocaptchaKey) {
    console.warn(
        'Warning: TWOCAPTCHA_API_KEY is not set — CAPTCHA solving will fail. Copy .env.example to .env and add your key.'
    );
}

app.listen(PORT, () => {
    console.log(`Dashboard: http://localhost:${PORT}`);
});
