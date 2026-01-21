// =============================================================================
// Internationalization (i18n)
// =============================================================================

const translations = {
  en: {
    // Status
    running: 'Running',
    stopped: 'Stopped',

    // Buttons
    start: 'Start',
    stop: 'Stop',
    openUi: 'Open UI',
    killPort: 'Kill Port',
    saveSettings: 'Save Settings',
    checkUpdate: 'Check',
    installUpdate: 'Install Update & Restart',
    clear: 'Clear',

    // Labels
    settings: 'Settings',
    port: 'Port',
    enableAuth: 'Enable Basic Authentication',
    username: 'Username',
    password: 'Password',
    startOnLogin: 'Start on login',
    updates: 'Updates',
    logs: 'Logs',

    // Update status
    checkingUpdates: 'Checking for updates...',
    latestVersion: 'You are using the latest version',
    updateAvailable: 'Update v{version} available, downloading...',
    downloading: 'Downloading v{version}... {percent}%',
    updateReady: 'Update v{version} ready to install',
    updateError: 'Error: {error}',

    // Dialogs
    killPortConfirm: 'Kill all processes using port {port}?',
    invalidPort: 'Please enter a valid port number (1024-65535)',
    settingsSaved: 'Settings saved! Server is restarting...',
    settingsFailed: 'Failed to save settings',
    installConfirm: 'Install update and restart the application?',
    killing: 'Killing...',
  },
  ja: {
    // Status
    running: '実行中',
    stopped: '停止中',

    // Buttons
    start: '起動',
    stop: '停止',
    openUi: 'UIを開く',
    killPort: 'ポートを解放',
    saveSettings: '設定を保存',
    checkUpdate: '確認',
    installUpdate: 'アップデートして再起動',
    clear: 'クリア',

    // Labels
    settings: '設定',
    port: 'ポート',
    enableAuth: 'Basic認証を有効にする',
    username: 'ユーザー名',
    password: 'パスワード',
    startOnLogin: 'ログイン時に自動起動',
    updates: 'アップデート',
    logs: 'ログ',

    // Update status
    checkingUpdates: 'アップデートを確認中...',
    latestVersion: '最新バージョンです',
    updateAvailable: 'v{version} をダウンロード中...',
    downloading: 'v{version} をダウンロード中... {percent}%',
    updateReady: 'v{version} のインストール準備完了',
    updateError: 'エラー: {error}',

    // Dialogs
    killPortConfirm: 'ポート {port} を使用中のプロセスを終了しますか？',
    invalidPort: '有効なポート番号を入力してください (1024-65535)',
    settingsSaved: '設定を保存しました。サーバーを再起動中...',
    settingsFailed: '設定の保存に失敗しました',
    installConfirm: 'アップデートをインストールして再起動しますか？',
    killing: '終了中...',
  }
};

let currentLang = 'ja';

function t(key, params = {}) {
  let text = translations[currentLang][key] || translations.en[key] || key;
  Object.entries(params).forEach(([k, v]) => {
    text = text.replace(`{${k}}`, v);
  });
  return text;
}

function updateUI() {
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    el.textContent = t(key);
  });
}

function setLanguage(lang) {
  currentLang = lang;
  localStorage.setItem('deck-ide-lang', lang);

  document.querySelectorAll('.lang-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.lang === lang);
  });

  updateUI();

  // Re-render dynamic content
  if (lastStatus) renderStatus(lastStatus);
  if (lastUpdateStatus) renderUpdateStatus(lastUpdateStatus);
}

// =============================================================================
// DOM Elements
// =============================================================================

const statusIndicator = document.getElementById('status-indicator');
const statusLabel = document.getElementById('status-label');
const statusUrl = document.getElementById('status-url');
const statusError = document.getElementById('status-error');
const startBtn = document.getElementById('start');
const stopBtn = document.getElementById('stop');
const openBtn = document.getElementById('open');
const autoStartInput = document.getElementById('autostart');
const logsEl = document.getElementById('logs');
const clearBtn = document.getElementById('clear');

// Settings elements
const portInput = document.getElementById('port');
const killPortBtn = document.getElementById('kill-port');
const basicAuthEnabledInput = document.getElementById('basicauth-enabled');
const basicAuthUsernameInput = document.getElementById('basicauth-username');
const basicAuthPasswordInput = document.getElementById('basicauth-password');
const basicAuthFieldsEl = document.getElementById('basicauth-fields');
const saveConfigBtn = document.getElementById('save-config');

// Update elements
const updateStatusEl = document.getElementById('update-status');
const updateProgressEl = document.getElementById('update-progress');
const updateProgressFillEl = document.getElementById('update-progress-fill');
const checkUpdateBtn = document.getElementById('check-update');
const installUpdateBtn = document.getElementById('install-update');

// Language buttons
const langBtns = document.querySelectorAll('.lang-btn');

// =============================================================================
// State
// =============================================================================

let lastStatus = null;
let lastUpdateStatus = null;

// =============================================================================
// Render Functions
// =============================================================================

const renderStatus = (status) => {
  if (!status) return;
  lastStatus = status;

  const isRunning = status.running;

  statusIndicator.classList.toggle('running', isRunning);
  statusIndicator.classList.toggle('stopped', !isRunning);
  statusLabel.textContent = isRunning ? t('running') : t('stopped');
  statusUrl.textContent = isRunning ? status.url : '';
  statusError.textContent = status.lastError || '';

  autoStartInput.checked = Boolean(status.autoStart);
  startBtn.disabled = isRunning;
  stopBtn.disabled = !isRunning;
};

const loadConfig = async () => {
  const config = await window.api.getConfig();
  portInput.value = config.port;
  basicAuthEnabledInput.checked = config.basicAuth.enabled;
  basicAuthUsernameInput.value = config.basicAuth.username;
  basicAuthPasswordInput.value = config.basicAuth.password;
  basicAuthFieldsEl.classList.toggle('visible', config.basicAuth.enabled);
};

const refresh = async () => {
  const status = await window.api.getStatus();
  renderStatus(status);
  const logs = await window.api.getLogs();
  logsEl.textContent = logs || '';
  logsEl.scrollTop = logsEl.scrollHeight;
  await loadConfig();
};

const renderUpdateStatus = (status) => {
  if (!status) return;
  lastUpdateStatus = status;

  updateStatusEl.classList.remove('available');

  if (status.checking) {
    updateStatusEl.textContent = t('checkingUpdates');
    updateProgressEl.style.display = 'none';
    installUpdateBtn.style.display = 'none';
    checkUpdateBtn.disabled = true;
  } else if (status.error) {
    updateStatusEl.textContent = t('updateError', { error: status.error });
    updateProgressEl.style.display = 'none';
    installUpdateBtn.style.display = 'none';
    checkUpdateBtn.disabled = false;
  } else if (status.downloaded) {
    updateStatusEl.textContent = t('updateReady', { version: status.version });
    updateStatusEl.classList.add('available');
    updateProgressEl.style.display = 'none';
    installUpdateBtn.style.display = 'block';
    checkUpdateBtn.disabled = false;
  } else if (status.available) {
    if (status.progress) {
      updateStatusEl.textContent = t('downloading', {
        version: status.version,
        percent: status.progress.percent
      });
      updateProgressEl.style.display = 'block';
      updateProgressFillEl.style.width = `${status.progress.percent}%`;
    } else {
      updateStatusEl.textContent = t('updateAvailable', { version: status.version });
      updateProgressEl.style.display = 'none';
    }
    installUpdateBtn.style.display = 'none';
    checkUpdateBtn.disabled = true;
  } else {
    updateStatusEl.textContent = t('latestVersion');
    updateProgressEl.style.display = 'none';
    installUpdateBtn.style.display = 'none';
    checkUpdateBtn.disabled = false;
  }
};

// =============================================================================
// Event Listeners
// =============================================================================

// Language switch
langBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    setLanguage(btn.dataset.lang);
  });
});

// Server controls
startBtn.addEventListener('click', async () => {
  const status = await window.api.startServer();
  renderStatus(status);
});

stopBtn.addEventListener('click', async () => {
  const status = await window.api.stopServer();
  renderStatus(status);
});

openBtn.addEventListener('click', async () => {
  await window.api.openUi();
});

autoStartInput.addEventListener('change', async (event) => {
  const status = await window.api.setAutoStart(event.target.checked);
  renderStatus(status);
});

clearBtn.addEventListener('click', async () => {
  const logs = await window.api.clearLogs();
  logsEl.textContent = logs || '';
});

// Port kill
killPortBtn.addEventListener('click', async () => {
  const port = parseInt(portInput.value, 10);
  if (!port || port < 1024 || port > 65535) {
    alert(t('invalidPort'));
    return;
  }

  if (!confirm(t('killPortConfirm', { port }))) {
    return;
  }

  killPortBtn.disabled = true;
  const originalText = killPortBtn.textContent;
  killPortBtn.textContent = t('killing');

  try {
    const result = await window.api.killPort(port);
    alert(result.message);
  } catch (error) {
    alert(`Error: ${error.message}`);
  } finally {
    killPortBtn.disabled = false;
    killPortBtn.textContent = originalText;
  }
});

// Auth fields toggle
basicAuthEnabledInput.addEventListener('change', (event) => {
  basicAuthFieldsEl.classList.toggle('visible', event.target.checked);
});

// Save config
saveConfigBtn.addEventListener('click', async () => {
  const config = {
    port: parseInt(portInput.value, 10),
    basicAuth: {
      enabled: basicAuthEnabledInput.checked,
      username: basicAuthUsernameInput.value,
      password: basicAuthPasswordInput.value
    }
  };

  const result = await window.api.saveConfig(config);
  if (result.success) {
    alert(t('settingsSaved'));
    renderStatus(result.status);
  } else {
    alert(t('settingsFailed'));
  }
});

// Update controls
checkUpdateBtn.addEventListener('click', async () => {
  checkUpdateBtn.disabled = true;
  const status = await window.api.checkForUpdates();
  renderUpdateStatus(status);
});

installUpdateBtn.addEventListener('click', async () => {
  if (confirm(t('installConfirm'))) {
    await window.api.installUpdate();
  }
});

// IPC listeners
window.api.onStatus((status) => {
  renderStatus(status);
});

window.api.onLog((text) => {
  logsEl.textContent += text;
  logsEl.scrollTop = logsEl.scrollHeight;
});

window.api.onUpdateStatus((status) => {
  renderUpdateStatus(status);
});

// =============================================================================
// Initialization
// =============================================================================

const loadUpdateStatus = async () => {
  const status = await window.api.getUpdateStatus();
  renderUpdateStatus(status);
};

// Load saved language or detect from system
const savedLang = localStorage.getItem('deck-ide-lang');
if (savedLang) {
  setLanguage(savedLang);
} else {
  // Auto-detect: use Japanese if system language includes 'ja'
  const systemLang = navigator.language || navigator.userLanguage || 'en';
  setLanguage(systemLang.startsWith('ja') ? 'ja' : 'en');
}

refresh();
loadUpdateStatus();
