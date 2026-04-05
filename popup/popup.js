// ─── Popup Controller ───
document.addEventListener('DOMContentLoaded', init);

// Icon classes for activity types
const ACTIVITY_ICONS = {
  'multiple-choice': 'ph-list-bullets',
  'short-answer': 'ph-text-aa',
  'participation': 'ph-play-circle',
  'animation': 'ph-film-strip',
  'coding': 'ph-code',
  'lab': 'ph-flask',
  'matching': 'ph-arrows-left-right',
  'true-false': 'ph-check-circle',
  'content-tool': 'ph-hand-tap',
  'challenge': 'ph-trophy',
  'custom-interaction': 'ph-puzzle-piece',
  'unknown': 'ph-question'
};

const LOG_ICONS = {
  'info': 'ph-info',
  'success': 'ph-check-circle',
  'error': 'ph-x-circle',
  'warn': 'ph-warning'
};

function init() {
  loadSettings();
  bindEvents();
  checkPage();
  updateModelHint();
}

// ─── Settings ───

function bindEvents() {
  document.getElementById('save-settings').addEventListener('click', saveSettings);
  document.getElementById('toggle-key').addEventListener('click', toggleKeyVisibility);
  document.getElementById('delay-slider').addEventListener('input', (e) => {
    document.getElementById('delay-value').textContent = e.target.value;
  });
  document.getElementById('model-select').addEventListener('change', updateModelHint);
  document.getElementById('btn-scan').addEventListener('click', scanPage);
  document.getElementById('btn-run').addEventListener('click', runAgent);
  document.getElementById('btn-stop').addEventListener('click', stopAgent);
}

async function loadSettings() {
  const data = await chrome.storage.local.get(['apiKey', 'model', 'autoSubmit', 'delay']);
  if (data.apiKey) document.getElementById('api-key').value = data.apiKey;
  if (data.model) document.getElementById('model-select').value = data.model;
  if (data.autoSubmit !== undefined) document.getElementById('auto-submit').checked = data.autoSubmit;
  if (data.delay) {
    document.getElementById('delay-slider').value = data.delay;
    document.getElementById('delay-value').textContent = data.delay;
  }
  updateModelHint();
}

const MODEL_HINTS = {
  'gpt-5.4':        'Frontier reasoning model. Best for complex coding & agentic tasks.',
  'gpt-5.4-mini':   'Fast & powerful reasoning. Great balance of speed and intelligence.',
  'gpt-5.4-nano':   'Cheapest GPT-5 class. Good for simple high-volume tasks.',
  'gpt-4.1':       'Best overall quality. Great for complex coding & reasoning tasks.',
  'gpt-4.1-mini':  'Fast and smart. Good balance of speed and accuracy.',
  'gpt-4.1-nano':  'Ultra-fast and cheapest. Good for simple activities.',
  'o4-mini':       'Reasoning model — thinks step by step. Great for tricky code problems.',
  'o3':            'Most powerful reasoning model. Best for very hard problems. Slower & expensive.',
  'o3-mini':       'Efficient reasoning. Good for moderate code challenges.',
  'gpt-4o':        'Previous-gen flagship. Solid general performance.',
  'gpt-4o-mini':   'Previous-gen fast model. Good for simple tasks.',
  'gpt-4-turbo':   'Legacy model. Use GPT-4.1 instead.'
};

function updateModelHint() {
  const select = document.getElementById('model-select');
  const hint = document.getElementById('model-hint');
  if (hint) {
    hint.textContent = MODEL_HINTS[select.value] || '';
  }
}

async function saveSettings() {
  const apiKey = document.getElementById('api-key').value.trim();
  const model = document.getElementById('model-select').value;
  const autoSubmit = document.getElementById('auto-submit').checked;
  const delay = parseFloat(document.getElementById('delay-slider').value);

  if (!apiKey || apiKey.length < 10) {
    showStatus('settings-status', 'Please enter a valid API key', 'error');
    return;
  }

  await chrome.storage.local.set({ apiKey, model, autoSubmit, delay });
  showStatus('settings-status', 'Settings saved', 'success');
}

function toggleKeyVisibility() {
  const input = document.getElementById('api-key');
  const icon = document.getElementById('toggle-key-icon');
  if (input.type === 'password') {
    input.type = 'text';
    icon.className = 'ph ph-eye-slash';
  } else {
    input.type = 'password';
    icon.className = 'ph ph-eye';
  }
}

function showStatus(id, msg, type) {
  const el = document.getElementById(id);
  el.textContent = msg;
  el.className = `status ${type}`;
  setTimeout(() => { el.textContent = ''; el.className = 'status'; }, 3000);
}

// ─── Page Interaction ───

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function checkPage() {
  const tab = await getActiveTab();
  const dot = document.querySelector('.dot');
  const text = document.getElementById('page-status-text');

  if (tab && tab.url && (tab.url.includes('learn.zybooks.com') || tab.url.includes('zybooks.com'))) {
    dot.className = 'dot dot-ready';
    text.textContent = 'zyBooks page detected';
    document.getElementById('btn-scan').disabled = false;
  } else {
    dot.className = 'dot dot-error';
    text.textContent = 'Navigate to a zyBooks page first';
    document.getElementById('btn-scan').disabled = true;
    document.getElementById('btn-run').disabled = true;
  }
}

async function scanPage() {
  const tab = await getActiveTab();
  addLog('Scanning page for activities...', 'info');

  try {
    const results = await chrome.tabs.sendMessage(tab.id, { action: 'scan' });

    if (results && results.activities && results.activities.length > 0) {
      displayActivities(results.activities);
      document.getElementById('btn-run').disabled = false;
      addLog(`Found ${results.activities.length} activities`, 'success');
    } else {
      addLog('No activities found on this page. Make sure the page is fully loaded.', 'warn');
      document.getElementById('btn-run').disabled = true;
    }
  } catch (err) {
    addLog('Could not connect to page. Try refreshing.', 'error');
    console.error(err);
  }
}

function displayActivities(activities) {
  const section = document.getElementById('activity-summary');
  const list = document.getElementById('activity-list');
  section.style.display = 'block';
  list.innerHTML = '';

  const typeCounts = {};
  let completedCount = 0;
  activities.forEach(a => {
    typeCounts[a.type] = (typeCounts[a.type] || 0) + 1;
    if (a.completed) completedCount++;
  });

  // Summary by type
  Object.entries(typeCounts).forEach(([type, count]) => {
    const completedOfType = activities.filter(a => a.type === type && a.completed).length;
    const li = document.createElement('li');
    const iconClass = ACTIVITY_ICONS[type] || ACTIVITY_ICONS['unknown'];
    const statusText = completedOfType > 0 ? ` (${completedOfType}/${count} done)` : `: ${count}`;
    li.innerHTML = `<i class="ph ${iconClass}"></i> <span>${type}${statusText}</span>`;
    list.appendChild(li);
  });

  // Overall summary
  const summaryLi = document.createElement('li');
  summaryLi.innerHTML = `<i class="ph ph-chart-pie"></i> <strong>Total: ${completedCount}/${activities.length} completed</strong>`;
  summaryLi.style.borderTop = '1px solid #333';
  summaryLi.style.paddingTop = '4px';
  summaryLi.style.marginTop = '4px';
  list.appendChild(summaryLi);
}

// ─── Agent Execution ───

async function runAgent() {
  const settings = await chrome.storage.local.get(['apiKey', 'model', 'autoSubmit', 'delay']);

  if (!settings.apiKey) {
    addLog('Set your OpenAI API key first!', 'error');
    return;
  }

  const tab = await getActiveTab();

  document.getElementById('btn-run').style.display = 'none';
  document.getElementById('btn-stop').style.display = 'inline-flex';
  document.getElementById('progress-section').style.display = 'block';

  addLog('Starting agent...', 'info');

  try {
    chrome.tabs.sendMessage(tab.id, {
      action: 'run',
      settings: {
        apiKey: settings.apiKey,
        model: settings.model || 'gpt-4.1',
        autoSubmit: settings.autoSubmit !== false,
        delay: settings.delay || 1.5
      }
    });

    chrome.runtime.onMessage.addListener(function listener(msg) {
      if (msg.type === 'progress') {
        updateProgress(msg.current, msg.total, msg.message);
        addLog(msg.message, msg.level || 'info');
      }
      if (msg.type === 'done') {
        addLog('Agent finished!', 'success');
        resetControls();
        chrome.runtime.onMessage.removeListener(listener);
      }
      if (msg.type === 'error') {
        addLog(msg.message, 'error');
        resetControls();
        chrome.runtime.onMessage.removeListener(listener);
      }
    });
  } catch (err) {
    addLog(`Error: ${err.message}`, 'error');
    resetControls();
  }
}

async function stopAgent() {
  const tab = await getActiveTab();
  chrome.tabs.sendMessage(tab.id, { action: 'stop' });
  addLog('Agent stopped by user', 'warn');
  resetControls();
}

function resetControls() {
  document.getElementById('btn-run').style.display = 'inline-flex';
  document.getElementById('btn-stop').style.display = 'none';
}

function updateProgress(current, total, message) {
  const pct = total > 0 ? Math.round((current / total) * 100) : 0;
  document.getElementById('progress-fill').style.width = `${pct}%`;
  document.getElementById('progress-text').textContent = `${current}/${total} — ${message}`;
}

// ─── Logging ───

function addLog(message, level = 'info') {
  const container = document.getElementById('log-container');
  const entry = document.createElement('div');
  entry.className = `log-entry ${level}`;
  const time = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const iconClass = LOG_ICONS[level] || LOG_ICONS['info'];
  entry.innerHTML = `<span class="time">${time}</span><i class="ph ${iconClass}"></i> ${message}`;
  container.appendChild(entry);
  container.scrollTop = container.scrollHeight;
}
