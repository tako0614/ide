const statusEl = document.getElementById('status');
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

const renderStatus = (status) => {
  if (!status) return;
  statusEl.textContent = status.running
    ? `Running: ${status.url}`
    : 'Stopped';
  if (status.lastError) {
    statusEl.textContent = `${statusEl.textContent} | ${status.lastError}`;
  }
  autoStartInput.checked = Boolean(status.autoStart);
  startBtn.disabled = status.running;
  stopBtn.disabled = !status.running;
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

killPortBtn.addEventListener('click', async () => {
  const port = parseInt(portInput.value, 10);
  if (!port || port < 1024 || port > 65535) {
    alert('Please enter a valid port number (1024-65535)');
    return;
  }

  if (!confirm(`Kill all processes using port ${port}?`)) {
    return;
  }

  killPortBtn.disabled = true;
  killPortBtn.textContent = 'Killing...';

  try {
    const result = await window.api.killPort(port);
    if (result.success) {
      alert(result.message);
    } else {
      alert(`Failed: ${result.message}`);
    }
  } catch (error) {
    alert(`Error: ${error.message}`);
  } finally {
    killPortBtn.disabled = false;
    killPortBtn.textContent = '🗙 Kill Port';
  }
});

basicAuthEnabledInput.addEventListener('change', (event) => {
  basicAuthFieldsEl.classList.toggle('visible', event.target.checked);
});

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
    alert('Settings saved successfully! Server is restarting...');
    renderStatus(result.status);
  } else {
    alert('Failed to save settings');
  }
});

window.api.onStatus((status) => {
  renderStatus(status);
});

window.api.onLog((text) => {
  logsEl.textContent += text;
  logsEl.scrollTop = logsEl.scrollHeight;
});

// Update handling
const renderUpdateStatus = (status) => {
  if (!status) return;

  updateStatusEl.classList.remove('available');

  if (status.checking) {
    updateStatusEl.textContent = 'Checking for updates...';
    updateProgressEl.style.display = 'none';
    installUpdateBtn.style.display = 'none';
    checkUpdateBtn.disabled = true;
  } else if (status.error) {
    updateStatusEl.textContent = `Error: ${status.error}`;
    updateProgressEl.style.display = 'none';
    installUpdateBtn.style.display = 'none';
    checkUpdateBtn.disabled = false;
  } else if (status.downloaded) {
    updateStatusEl.textContent = `Update v${status.version} ready to install`;
    updateStatusEl.classList.add('available');
    updateProgressEl.style.display = 'none';
    installUpdateBtn.style.display = 'block';
    checkUpdateBtn.disabled = false;
  } else if (status.available) {
    if (status.progress) {
      updateStatusEl.textContent = `Downloading v${status.version}... ${status.progress.percent}%`;
      updateProgressEl.style.display = 'block';
      updateProgressFillEl.style.width = `${status.progress.percent}%`;
    } else {
      updateStatusEl.textContent = `Update v${status.version} available, downloading...`;
      updateProgressEl.style.display = 'none';
    }
    installUpdateBtn.style.display = 'none';
    checkUpdateBtn.disabled = true;
  } else {
    updateStatusEl.textContent = 'You are using the latest version';
    updateProgressEl.style.display = 'none';
    installUpdateBtn.style.display = 'none';
    checkUpdateBtn.disabled = false;
  }
};

checkUpdateBtn.addEventListener('click', async () => {
  checkUpdateBtn.disabled = true;
  const status = await window.api.checkForUpdates();
  renderUpdateStatus(status);
});

installUpdateBtn.addEventListener('click', async () => {
  if (confirm('Install update and restart the application?')) {
    await window.api.installUpdate();
  }
});

window.api.onUpdateStatus((status) => {
  renderUpdateStatus(status);
});

// Initial load
const loadUpdateStatus = async () => {
  const status = await window.api.getUpdateStatus();
  renderUpdateStatus(status);
};

refresh();
loadUpdateStatus();
