/**
 * Deck IDE Desktop - メインエントリーポイント
 * Electronアプリケーションの起動とIPCハンドラーの登録
 */

const { app, ipcMain, shell } = require('electron');
const path = require('path');

const serverManager = require('./server-manager.cjs');
const logManager = require('./log-manager.cjs');
const windowManager = require('./window-manager.cjs');
const autoUpdater = require('./auto-updater.cjs');
const {
  setAutoStartEnabled,
  loadConfig,
  saveConfig,
  killProcessOnPort
} = require('./config-manager.cjs');

/**
 * 単一インスタンスのロックを取得
 * 既にアプリが起動している場合は、既存のウィンドウをフォーカス
 */
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  // 既に別のインスタンスが起動中なので終了
  app.quit();
} else {
  // 2つ目のインスタンスが起動しようとした時
  app.on('second-instance', () => {
    // 既存のウィンドウを表示してフォーカス
    windowManager.showWindow();
  });
}

/**
 * アプリケーション起動時の初期化
 */
app.whenReady().then(() => {
  // ログファイルのパスを設定
  const logDir = app.getPath('userData');
  const logFilePath = path.join(logDir, 'server.log');
  logManager.setLogFilePath(logFilePath);

  // メインウィンドウを作成
  const mainWindow = windowManager.createMainWindow();

  // 各マネージャーにウィンドウ参照を設定
  logManager.setMainWindow(mainWindow);
  serverManager.setMainWindow(mainWindow);
  autoUpdater.setMainWindow(mainWindow);

  // サーバーを起動
  serverManager.start();

  // アップデートをチェック（起動後5秒待機）
  setTimeout(() => {
    autoUpdater.checkForUpdates();
  }, 5000);
});

/**
 * アプリケーション終了前の処理
 */
app.on('before-quit', () => {
  windowManager.setQuitting(true);
  serverManager.stop();
});

/**
 * 全ウィンドウが閉じられた時の処理
 * トレイに最小化している場合は終了しない
 */
app.on('window-all-closed', () => {
  // macOS以外では、トレイからQuitを選択した場合のみ終了
  // ウィンドウを閉じただけの場合はトレイに残る
});

/**
 * macOS: Dockアイコンクリック時にウィンドウを表示
 */
app.on('activate', () => {
  windowManager.showWindow();
});

/**
 * IPCハンドラーの登録
 */

// サーバー情報を取得
ipcMain.handle('server-info', () => {
  return serverManager.getStatus();
});

// サーバーログを取得
ipcMain.handle('server-logs', () => {
  return logManager.getLogs();
});

// ログをクリア
ipcMain.handle('logs-clear', () => {
  return logManager.clearLogs();
});

// サーバーを起動
ipcMain.handle('server-start', () => {
  serverManager.start();
  return serverManager.getStatus();
});

// サーバーを停止
ipcMain.handle('server-stop', () => {
  serverManager.stop();
  return serverManager.getStatus();
});

// サーバーURLをブラウザで開く
ipcMain.handle('server-open', () => {
  shell.openExternal(serverManager.getUrl());
  return serverManager.getStatus();
});

// 自動起動設定を変更
ipcMain.handle('autostart-set', (_, enabled) => {
  setAutoStartEnabled(enabled);
  return serverManager.getStatus();
});

// 設定を取得
ipcMain.handle('config-get', () => {
  return loadConfig();
});

// 設定を保存してサーバーを再起動
ipcMain.handle('config-save', (_, config) => {
  const success = saveConfig(config);
  if (success) {
    // サーバーを再起動して新しい設定を反映
    serverManager.stop();
    setTimeout(() => {
      serverManager.start();
    }, 500);
  }
  return { success, status: serverManager.getStatus() };
});

// ポートを使用しているプロセスをkill
ipcMain.handle('port-kill', async (_, port) => {
  return await killProcessOnPort(port);
});

// アップデートステータスを取得
ipcMain.handle('update-status', () => {
  return autoUpdater.getStatus();
});

// アップデートをチェック
ipcMain.handle('update-check', () => {
  autoUpdater.checkForUpdates();
  return autoUpdater.getStatus();
});

// アップデートをインストールして再起動
ipcMain.handle('update-install', () => {
  autoUpdater.quitAndInstall();
});
