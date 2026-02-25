/**
 * 設定管理モジュール
 * アプリケーション設定の読み書きを担当
 */

const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const { DEFAULT_PORT } = require('./constants.cjs');

/**
 * サーバーエントリーポイントのパスを解決
 */
const resolveServerEntry = () => {
  if (app.isPackaged) {
    // asarUnpackされたserverディレクトリを参照
    return path.join(process.resourcesPath, 'app.asar.unpacked', 'server', 'index.js');
  }
  return path.resolve(__dirname, '..', '..', 'server', 'dist', 'index.js');
};

/**
 * Node.jsバイナリのパスを解決
 */
const resolveNodeBinary = () => {
  return process.env.DECK_IDE_NODE || process.execPath;
};

/**
 * NODE_PATH環境変数の値を取得
 */
const getNodePath = () => {
  const candidates = [
    path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules'),
    path.join(app.getAppPath(), 'node_modules'),
    path.join(process.resourcesPath, 'node_modules')
  ];
  return candidates
    .filter((candidate) => fs.existsSync(candidate))
    .join(path.delimiter);
};

/**
 * データベースファイルのパスを取得
 */
const getDbPath = () => {
  const base = app.getPath('userData');
  return path.join(base, 'data', 'deck-ide.db');
};

/**
 * 設定ファイルのパスを取得
 */
const getConfigPath = () => {
  const base = app.getPath('userData');
  return path.join(base, 'config.json');
};

/**
 * デフォルト設定
 */
const getDefaultConfig = () => {
  return {
    port: DEFAULT_PORT,
    basicAuth: {
      enabled: false,
      username: '',
      password: ''
    }
  };
};

/**
 * 設定を読み込む
 */
const loadConfig = () => {
  const configPath = getConfigPath();
  try {
    if (fs.existsSync(configPath)) {
      const data = fs.readFileSync(configPath, 'utf-8');
      return { ...getDefaultConfig(), ...JSON.parse(data) };
    }
  } catch (error) {
    console.error('Failed to load config:', error);
  }
  return getDefaultConfig();
};

/**
 * 設定を保存する
 */
const saveConfig = (config) => {
  const configPath = getConfigPath();
  try {
    const dir = path.dirname(configPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
    return true;
  } catch (error) {
    console.error('Failed to save config:', error);
    return false;
  }
};

/**
 * サーバー起動時の環境変数を生成
 */
const getServerEnvironment = (config = null) => {
  const nodeBinary = resolveNodeBinary();
  const currentConfig = config || loadConfig();

  const env = {
    ...process.env,
    PORT: String(currentConfig.port),
    NODE_PATH: getNodePath(),
    DB_PATH: getDbPath()
  };

  // Basic認証設定
  if (currentConfig.basicAuth && currentConfig.basicAuth.enabled) {
    env.BASIC_AUTH_USER = currentConfig.basicAuth.username;
    env.BASIC_AUTH_PASSWORD = currentConfig.basicAuth.password;
  }

  if (nodeBinary === process.execPath) {
    env.ELECTRON_RUN_AS_NODE = '1';
  }

  return env;
};

/**
 * 自動起動設定を取得
 */
const getAutoStartEnabled = () => {
  return app.getLoginItemSettings().openAtLogin;
};

/**
 * 自動起動設定を変更
 */
const setAutoStartEnabled = (enabled) => {
  app.setLoginItemSettings({
    openAtLogin: Boolean(enabled),
    openAsHidden: true
  });
};

/**
 * 指定ポートを使用しているプロセスをkillする
 */
const killProcessOnPort = async (port) => {
  const { exec } = require('child_process');
  const { promisify } = require('util');
  const execAsync = promisify(exec);

  try {
    if (process.platform === 'win32') {
      // Windows: netstat でポートを使用しているPIDを取得
      const { stdout } = await execAsync(`netstat -ano | findstr :${port}`);
      const lines = stdout.trim().split('\n');

      const pids = new Set();
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        const pid = parts[parts.length - 1];
        if (pid && pid !== '0' && !isNaN(pid)) {
          pids.add(pid);
        }
      }

      if (pids.size === 0) {
        return { success: false, message: `No process found on port ${port}` };
      }

      // 各PIDをkill
      for (const pid of pids) {
        try {
          await execAsync(`taskkill /PID ${pid} /F`);
          console.log(`Killed process ${pid} on port ${port}`);
        } catch (err) {
          console.error(`Failed to kill PID ${pid}:`, err.message);
        }
      }

      return { success: true, message: `Killed ${pids.size} process(es) on port ${port}` };
    } else {
      // Unix系: lsof でPIDを取得
      try {
        const { stdout } = await execAsync(`lsof -ti :${port}`);
        const pids = stdout.trim().split('\n').filter(pid => pid);

        if (pids.length === 0) {
          return { success: false, message: `No process found on port ${port}` };
        }

        // 各PIDをkill
        for (const pid of pids) {
          await execAsync(`kill -9 ${pid}`);
          console.log(`Killed process ${pid} on port ${port}`);
        }

        return { success: true, message: `Killed ${pids.length} process(es) on port ${port}` };
      } catch (err) {
        if (err.message.includes('lsof: command not found')) {
          // lsofが使えない場合、netstatを試す
          const { stdout } = await execAsync(`netstat -vanp tcp | grep ${port}`);
          const lines = stdout.trim().split('\n');
          const pids = new Set();

          for (const line of lines) {
            const match = line.match(/\s+(\d+)\//);
            if (match) {
              pids.add(match[1]);
            }
          }

          if (pids.size === 0) {
            return { success: false, message: `No process found on port ${port}` };
          }

          for (const pid of pids) {
            await execAsync(`kill -9 ${pid}`);
          }

          return { success: true, message: `Killed ${pids.size} process(es) on port ${port}` };
        }
        throw err;
      }
    }
  } catch (error) {
    console.error('Failed to kill process on port:', error);
    return { success: false, message: error.message };
  }
};

module.exports = {
  resolveServerEntry,
  resolveNodeBinary,
  getNodePath,
  getDbPath,
  getConfigPath,
  getDefaultConfig,
  loadConfig,
  saveConfig,
  getServerEnvironment,
  getAutoStartEnabled,
  setAutoStartEnabled,
  killProcessOnPort
};
