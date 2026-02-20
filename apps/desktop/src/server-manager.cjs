/**
 * サーバープロセス管理モジュール
 * サーバーの起動、停止、状態管理を担当
 */

const { spawn } = require('child_process');
const fs = require('fs');
const { SERVER_URL_FALLBACK } = require('./constants.cjs');
const {
  resolveServerEntry,
  resolveNodeBinary,
  getServerEnvironment,
  getAutoStartEnabled
} = require('./config-manager.cjs');
const logManager = require('./log-manager.cjs');

class ServerManager {
  constructor() {
    this.serverProcess = null;
    this.serverUrl = SERVER_URL_FALLBACK;
    this.lastError = '';
    this.mainWindow = null;
  }

  /**
   * メインウィンドウの参照を設定
   */
  setMainWindow(window) {
    this.mainWindow = window;
  }

  /**
   * サーバーステータスを取得
   */
  getStatus() {
    return {
      running: Boolean(this.serverProcess),
      url: this.serverUrl,
      lastError: this.lastError,
      autoStart: getAutoStartEnabled()
    };
  }

  /**
   * ステータスをウィンドウにブロードキャスト
   * immediate=true のときは即時送信、false のときは 500ms デバウンス
   */
  broadcastStatus(immediate = false) {
    if (!this.mainWindow) return;
    if (immediate) {
      if (this._statusTimer) {
        clearTimeout(this._statusTimer);
        this._statusTimer = null;
      }
      this.mainWindow.webContents.send('server-status', this.getStatus());
      return;
    }
    if (this._statusTimer) return;
    this._statusTimer = setTimeout(() => {
      this._statusTimer = null;
      if (this.mainWindow) {
        this.mainWindow.webContents.send('server-status', this.getStatus());
      }
    }, 500);
  }

  /**
   * ログからサーバーURLを解析
   */
  parseServerUrl(text) {
    const match = text.match(/Deck IDE server listening on (http[^\s]+)/);
    if (match) {
      this.serverUrl = match[1];
    }
  }

  /**
   * サーバープロセスを起動
   */
  start() {
    if (this.serverProcess) {
      return;
    }

    const entry = resolveServerEntry();
    if (!fs.existsSync(entry)) {
      this.lastError = `Server entry not found: ${entry}`;
      this.broadcastStatus();
      return;
    }

    this.lastError = '';
    const nodeBinary = resolveNodeBinary();
    const env = getServerEnvironment();

    this.serverProcess = spawn(nodeBinary, [entry], {
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    this.serverProcess.on('error', (error) => {
      this.lastError = error.message;
      this.serverProcess = null;
      this.broadcastStatus();
    });

    this.serverProcess.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      logManager.appendLog(text);
      this.parseServerUrl(text);
      this.broadcastStatus(false); // デバウンス
    });

    this.serverProcess.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      logManager.appendLog(text);
      this.lastError = text.trim();
      this.broadcastStatus(false); // デバウンス
    });

    this.serverProcess.on('exit', (code) => {
      this.serverProcess = null;
      if (code && code !== 0) {
        this.lastError = `Server exited with code ${code}`;
      }
      logManager.appendLog(`\n${this.lastError || 'Server stopped.'}\n`);
      this.broadcastStatus(true); // 即時
    });

    logManager.appendLog(`\nStarting server with ${nodeBinary}...\n`);
    this.broadcastStatus(true); // 即時
  }

  /**
   * サーバープロセスを停止
   * SIGINTを送って graceful shutdown を試み、タイムアウト後に強制終了
   */
  stop() {
    if (!this.serverProcess) {
      return;
    }

    const proc = this.serverProcess;
    this.serverProcess = null;
    logManager.appendLog('\nStop requested, saving state...\n');
    this.broadcastStatus();

    // Try graceful shutdown with SIGINT first
    try {
      proc.kill('SIGINT');
    } catch (e) {
      // Ignore error, will force kill below
    }

    // Force kill after timeout if still running
    const forceKillTimeout = setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch (e) {
        // Process already dead
      }
    }, 3000);

    proc.once('exit', () => {
      clearTimeout(forceKillTimeout);
    });
  }

  /**
   * サーバーURLを取得
   */
  getUrl() {
    return this.serverUrl;
  }
}

module.exports = new ServerManager();
