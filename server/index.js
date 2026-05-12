const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const store = require('../lib/store');
const sse = require('../lib/sse-hub');
const { closeBrowser, COOKIES_FILE } = require('../lib/marketplace');
const {
  startWorker,
  stopWorker,
  scheduleImmediateFetchForWatch,
  POLL_MS,
} = require('../lib/poll-worker');

const app = express();
const PORT = Number(process.env.PORT) || 3847;
const PUBLIC = path.join(__dirname, '..', 'public');

app.use(cors());
app.use(express.json());
app.use(express.static(PUBLIC));

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    cookiesFileExists: fs.existsSync(COOKIES_FILE),
    headless: process.env.HEADLESS !== '0',
    pollIntervalMs: POLL_MS,
    sseClients: sse.clientCount(),
  });
});

app.get('/api/watches', (_req, res) => {
  res.json({ watches: store.getAllSummaries() });
});

app.post('/api/watches', (req, res) => {
  try {
    const query = (req.body && req.body.query) || '';
    const w = store.addWatch(query);
    const sum = store.getAllSummaries().find((s) => s.id === w.id);
    sse.broadcast('watches_state', { watches: store.getAllSummaries() });
    scheduleImmediateFetchForWatch(w.id);
    res.status(201).json({ watch: sum });
  } catch (err) {
    res.status(400).json({ error: err.message || 'Invalid request' });
  }
});

app.get('/api/watches/:id', (req, res) => {
  const data = store.getWatchPublic(req.params.id);
  if (!data) return res.status(404).json({ error: 'Watch not found' });
  res.json(data);
});

app.delete('/api/watches/:id', (req, res) => {
  const ok = store.removeWatch(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Watch not found' });
  sse.broadcast('watches_state', { watches: store.getAllSummaries() });
  res.status(204).end();
});

app.post('/api/watches/:id/ack', (req, res) => {
  const w = store.ackWatch(req.params.id);
  if (!w) return res.status(404).json({ error: 'Watch not found' });
  sse.broadcast('watches_state', { watches: store.getAllSummaries() });
  res.json({ watch: store.getAllSummaries().find((s) => s.id === w.id) });
});

app.post('/api/watches/:id/refresh', (req, res) => {
  const w = store.findWatch(req.params.id);
  if (!w) return res.status(404).json({ error: 'Watch not found' });
  scheduleImmediateFetchForWatch(w.id);
  res.json({ ok: true, message: 'Refresh queued' });
});

app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  if (res.flushHeaders) res.flushHeaders();

  sse.addClient(res);

  const snapshot = { watches: store.getAllSummaries() };
  res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);

  req.on('close', () => {
    try {
      res.end();
    } catch {
      /* ignore */
    }
  });
});

process.on('SIGINT', async () => {
  stopWorker();
  await closeBrowser();
  process.exit(0);
});
process.on('SIGTERM', async () => {
  stopWorker();
  await closeBrowser();
  process.exit(0);
});

app.listen(PORT, () => {
  startWorker();
  console.log(`Dashboard: http://localhost:${PORT}`);
  console.log(`Cookies file: ${COOKIES_FILE} (${fs.existsSync(COOKIES_FILE) ? 'found' : 'missing — copy cookies.example.json'})`);
  console.log(`Poll interval: ${POLL_MS}ms (set POLL_INTERVAL_MS to change)`);
});
