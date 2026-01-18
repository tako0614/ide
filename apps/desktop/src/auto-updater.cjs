/**
 * 自動アップデートモジュール
 * GitHub Releasesからアップデートをチェックしてインストール
 */

const { autoUpdater } = require('electron-updater');
const { app } = require('electron');

class AutoUpdaterManager {
  constructor() {
    this.mainWindow = null;
    this.updateStatus = {
      checking: false,
      available: false,
      downloaded: false,
      error: null,
      progress: null,
      version: null
    };

    // ログ出力を有効化
    autoUpdater.logger = require('electron').app.isPackaged ? null : console;

    // 自動ダウンロードを有効化
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;

    this.setupEventHandlers();
  }

  /**
   * メインウィンドウの参照を設定
   */
  setMainWindow(window) {
    this.mainWindow = window;
  }

  /**
   * イベントハンドラーを設定
   */
  setupEventHandlers() {
    autoUpdater.on('checking-for-update', () => {
      this.updateStatus = {
        ...this.updateStatus,
        checking: true,
        error: null
      };
      this.broadcastStatus();
      console.log('[AutoUpdater] Checking for update...');
    });

    autoUpdater.on('update-available', (info) => {
      this.updateStatus = {
        ...this.updateStatus,
        checking: false,
        available: true,
        version: info.version
      };
      this.broadcastStatus();
      console.log(`[AutoUpdater] Update available: ${info.version}`);
    });

    autoUpdater.on('update-not-available', (info) => {
      this.updateStatus = {
        ...this.updateStatus,
        checking: false,
        available: false
      };
      this.broadcastStatus();
      console.log('[AutoUpdater] Update not available');
    });

    autoUpdater.on('error', (err) => {
      this.updateStatus = {
        ...this.updateStatus,
        checking: false,
        error: err.message
      };
      this.broadcastStatus();
      console.error('[AutoUpdater] Error:', err);
    });

    autoUpdater.on('download-progress', (progress) => {
      this.updateStatus = {
        ...this.updateStatus,
        progress: {
          percent: Math.round(progress.percent),
          transferred: progress.transferred,
          total: progress.total
        }
      };
      this.broadcastStatus();
    });

    autoUpdater.on('update-downloaded', (info) => {
      this.updateStatus = {
        ...this.updateStatus,
        downloaded: true,
        progress: null,
        version: info.version
      };
      this.broadcastStatus();
      console.log(`[AutoUpdater] Update downloaded: ${info.version}`);
    });
  }

  /**
   * ステータスをウィンドウにブロードキャスト
   */
  broadcastStatus() {
    if (!this.mainWindow) return;
    this.mainWindow.webContents.send('update-status', this.updateStatus);
  }

  /**
   * アップデートをチェック
   */
  checkForUpdates() {
    if (!app.isPackaged) {
      console.log('[AutoUpdater] Skipping update check in development mode');
      return;
    }
    autoUpdater.checkForUpdates();
  }

  /**
   * アップデートをインストールして再起動
   */
  quitAndInstall() {
    autoUpdater.quitAndInstall();
  }

  /**
   * 現在のステータスを取得
   */
  getStatus() {
    return this.updateStatus;
  }
}

module.exports = new AutoUpdaterManager();
