const form = document.getElementById('scrape-form');
const dateInput = document.getElementById('date');
const scrapeBtn = document.getElementById('scrape-btn');
const statusMsg = document.getElementById('status-msg');
const progressEl = document.getElementById('progress');
const progressFill = document.getElementById('progress-fill');
const progressText = document.getElementById('progress-text');
const historyBody = document.getElementById('history-body');
const refreshBtn = document.getElementById('refresh-btn');
const stopBtn = document.getElementById('stop-btn');
const clearHistoryBtn = document.getElementById('clear-history-btn');

let pollTimer = null;
let runningDate = null;

dateInput.value = new Date().toISOString().slice(0, 10);

function showStatus(text, type = '') {
  statusMsg.hidden = false;
  statusMsg.textContent = text;
  statusMsg.className = `status-msg ${type}`.trim();
}

function hideStatus() {
  statusMsg.hidden = true;
}

function formatDateTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString();
}

function statusBadge(status) {
  return `<span class="badge badge-${status}">${status}</span>`;
}

function renderHistory(searches) {
  if (!searches.length) {
    historyBody.innerHTML =
      '<tr><td colspan="6" class="empty">No searches yet</td></tr>';
    return;
  }

  historyBody.innerHTML = searches
    .map((s) => {
      const canDownload = s.status === 'completed';
      return `<tr>
        <td>${s.date}</td>
        <td>${statusBadge(s.status)}</td>
        <td>${s.raceCount ?? '—'}</td>
        <td>${s.runnerCount ?? '—'}</td>
       
        <td class="actions">
          <a class="link-btn ${canDownload ? '' : 'disabled'}" href="/api/download/${s.date}.csv" download>CSV</a>
        </td>
      </tr>`;
    })
    .join('');
}

async function loadHistory() {
  const res = await fetch('/api/history');
  const data = await res.json();
  renderHistory(data.searches || []);
  return data.searches || [];
}

function updateProgress(job) {
  progressEl.hidden = false;
  const p = job.progress || {};

  if (p.phase === 'captcha') {
    progressFill.style.width = '8%';
    progressText.textContent = p.message || 'Solving CAPTCHA…';
  } else if (p.phase === 'race' && p.total) {
    const pct = Math.round((p.current / p.total) * 100);
    progressFill.style.width = `${pct}%`;
    progressText.textContent = `Scraping race ${p.current} of ${p.total}…`;
  } else if (p.phase === 'urls' && p.total != null) {
    progressFill.style.width = '5%';
    progressText.textContent = `Found ${p.total} races. Starting…`;
  } else {
    progressFill.style.width = '2%';
    progressText.textContent = p.message || 'Working…';
  }
}

function setJobRunning(running) {
  scrapeBtn.disabled = running;
  stopBtn.hidden = !running;
  if (!running) runningDate = null;
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function finishJob(job) {
  stopPolling();
  progressEl.hidden = true;
  setJobRunning(false);

  if (job?.status === 'completed') {
    showStatus(
      `Done — ${job.raceCount} races, ${job.runnerCount} runners.`,
      'success'
    );
  } else if (job?.status === 'cancelled') {
    showStatus('Scrape cancelled.', 'error');
  } else if (job) {
    showStatus(job.error || 'Scrape failed.', 'error');
  }
}

function startPolling(date) {
  stopPolling();
  pollTimer = setInterval(async () => {
    try {
      const res = await fetch(`/api/scrape/${date}/status`);
      if (!res.ok) return;
      const job = await res.json();

      if (job.status === 'running') {
        updateProgress(job);
        return;
      }

      finishJob(job);
      await loadHistory();
    } catch {
      /* retry on next tick */
    }
  }, 2000);
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const date = dateInput.value;
  if (!date) return;

  setJobRunning(true);
  runningDate = date;
  hideStatus();
  progressEl.hidden = false;
  progressFill.style.width = '2%';
  progressText.textContent = 'Starting scrape…';

  try {
    const res = await fetch('/api/scrape', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date }),
    });
    const data = await res.json();

    if (!res.ok) {
      showStatus(data.error || 'Could not start scrape.', 'error');
      setJobRunning(false);
      progressEl.hidden = true;
      return;
    }

    showStatus(`Scraping racecards for ${date}…`);
    startPolling(date);
    await loadHistory();
  } catch (err) {
    showStatus(err.message || 'Network error.', 'error');
    setJobRunning(false);
    progressEl.hidden = true;
  }
});

stopBtn.addEventListener('click', async () => {
  stopBtn.disabled = true;
  showStatus('Stopping scrape…');

  try {
    const res = await fetch('/api/job/stop', { method: 'POST' });
    const data = await res.json();

    if (!res.ok) {
      showStatus(data.error || 'Could not stop job.', 'error');
      stopBtn.disabled = false;
      return;
    }

    if (runningDate) startPolling(runningDate);
  } catch (err) {
    showStatus(err.message || 'Network error.', 'error');
    stopBtn.disabled = false;
  }
});

clearHistoryBtn.addEventListener('click', async () => {
  const message = runningDate
    ? 'This will stop the running job and delete all history and saved results. Continue?'
    : 'Delete all search history and saved results?';

  if (!confirm(message)) return;

  clearHistoryBtn.disabled = true;

  try {
    const res = await fetch('/api/history', { method: 'DELETE' });
    const data = await res.json();

    if (!res.ok) {
      showStatus(data.error || 'Could not clear history.', 'error');
      return;
    }

    stopPolling();
    setJobRunning(false);
    progressEl.hidden = true;
    hideStatus();
    await loadHistory();
  } catch (err) {
    showStatus(err.message || 'Network error.', 'error');
  } finally {
    clearHistoryBtn.disabled = false;
  }
});

refreshBtn.addEventListener('click', loadHistory);

loadHistory().then((searches) => {
  const running = searches.find((s) => s.status === 'running');
  if (running) {
    runningDate = running.date;
    setJobRunning(true);
    showStatus(`Scrape in progress for ${running.date}…`);
    startPolling(running.date);
  }
});
