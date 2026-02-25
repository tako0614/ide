/**
 * ウィンドウ管理モジュール
 * Electronウィンドウの作成と管理を担当
 */

const { BrowserWindow, Tray, Menu, nativeImage, app } = require('electron');
const path = require('path');

class WindowManager {
  constructor() {
    this.mainWindow = null;
    this.tray = null;
    this.isQuitting = false;
  }

  /**
   * メインウィンドウを作成
   */
  createMainWindow() {
    this.mainWindow = new BrowserWindow({
      width: 420,
      height: 520,
      resizable: false,
      webPreferences: {
        preload: path.join(__dirname, 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false
      }
    });

    this.mainWindow.loadFile(path.join(__dirname, 'index.html'));

    // 閉じるボタンでウィンドウを非表示にする（トレイに最小化）
    this.mainWindow.on('close', (event) => {
      if (!this.isQuitting) {
        event.preventDefault();
        this.mainWindow.hide();
      }
    });

    this.mainWindow.on('closed', () => {
      this.mainWindow = null;
    });

    // システムトレイを作成
    this.createTray();

    return this.mainWindow;
  }

  /**
   * システムトレイを作成
   */
  createTray() {
    // 16x16のシンプルなアイコンを作成
    const icon = nativeImage.createFromDataURL(
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAABHNCSVQICAgIfAhkiAAAAAlwSFlzAAAAdgAAAHYBTnsmCAAAABl0RVh0U29mdHdhcmUAd3d3Lmlua3NjYXBlLm9yZ5vuPBoAAADESURBVDiNpZMxDsIwDEV/0g4sHIGJE3ADRi7AwMbGxsIpuAoXYGZhYOMITByBgYGBSkjFKk0aWvhS5Dj+/nFsp4B/QeRkGxHuIYN/CfAGXIEBkPpEbIDzN3d2gLGZc38JkQ8EB2Bhrc0AAmACLN1Y7zMAI2DsYwdAtJYDfzTQA6ZABHwAT8DTxypgnQNk1trbD7BKKb8AeAPOwNZ9NwIqILtEvNL6yH4gJhm9AWsf2AHGwMaNOcAFOAEHYO/Ftr+Ef8EHoJpXp5CtvWMAAAAASUVORK5CYII='
    );

    this.tray = new Tray(icon);
    this.tray.setToolTip('Deck IDE Server');

    const contextMenu = Menu.buildFromTemplate([
      {
        label: 'Show',
        click: () => {
          this.showWindow();
        }
      },
      {
        label: 'Hide',
        click: () => {
          this.mainWindow?.hide();
        }
      },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          this.quit();
        }
      }
    ]);

    this.tray.setContextMenu(contextMenu);

    // トレイアイコンクリックでウィンドウを表示
    // macOS: シングルクリック、Windows/Linux: ダブルクリック
    const clickEvent = process.platform === 'darwin' ? 'click' : 'double-click';
    this.tray.on(clickEvent, () => {
      this.showWindow();
    });
  }

  /**
   * ウィンドウを表示
   */
  showWindow() {
    if (this.mainWindow) {
      this.mainWindow.show();
      this.mainWindow.focus();
    }
  }

  /**
   * アプリケーションを終了
   */
  quit() {
    this.isQuitting = true;
    app.quit();
  }

  /**
   * 終了フラグを設定
   */
  setQuitting(value) {
    this.isQuitting = value;
  }

  /**
   * メインウィンドウの参照を取得
   */
  getMainWindow() {
    return this.mainWindow;
  }

  /**
   * メインウィンドウが存在するかチェック
   */
  hasMainWindow() {
    return this.mainWindow !== null;
  }
}

module.exports = new WindowManager();
