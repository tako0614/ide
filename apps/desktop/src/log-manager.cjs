/**
 * ログ管理モジュール
 * サーバーログの保存、取得、クリアを担当
 */

const fs = require('fs');
const { LOG_LINE_LIMIT } = require('./constants.cjs');

class LogManager {
  constructor() {
    this.logBuffer = [];
    this.logFilePath = '';
    this.mainWindow = null;
    this._pendingLog = '';
    this._logTimer = null;
  }

  /**
   * ログファイルのパスを設定
   */
  setLogFilePath(filePath) {
    this.logFilePath = filePath;
  }

  /**
   * メインウィンドウの参照を設定
   */
  setMainWindow(window) {
    this.mainWindow = window;
  }

  /**
   * ログにテキストを追加
   */
  appendLog(text) {
    if (!text) return;

    const normalized = text.replace(/\r\n/g, '\n');
    const lines = normalized.split('\n');

    lines.forEach((line, index) => {
      if (line === '' && index === lines.length - 1) return;
      this.logBuffer.push(line);
    });

    if (this.logBuffer.length > LOG_LINE_LIMIT) {
      this.logBuffer.splice(0, this.logBuffer.length - LOG_LINE_LIMIT);
    }

    if (this.logFilePath) {
      fs.appendFile(this.logFilePath, `${normalized}`, () => undefined);
    }

    if (this.mainWindow) {
      // バッチ送信: 200ms ごとにまとめて IPC を送る
      this._pendingLog += normalized;
      if (!this._logTimer) {
        this._logTimer = setTimeout(() => {
          this._logTimer = null;
          const batch = this._pendingLog;
          this._pendingLog = '';
          if (this.mainWindow && batch) {
            this.mainWindow.webContents.send('server-log', batch);
          }
        }, 200);
      }
    }
  }

  /**
   * 現在のログを取得
   */
  getLogs() {
    return this.logBuffer.join('\n');
  }

  /**
   * ログをクリア
   */
  clearLogs() {
    this.logBuffer.length = 0;
    if (this.logFilePath) {
      fs.writeFileSync(this.logFilePath, '');
    }
    return this.logBuffer.join('\n');
  }
}

module.exports = new LogManager();
