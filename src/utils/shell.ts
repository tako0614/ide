import { execSync } from 'node:child_process';
import path from 'node:path';

export function getDefaultShell(): string {
  return (
    process.env.SHELL ||
    (process.platform === 'win32' ? 'powershell.exe' : 'bash')
  );
}

// `locale -a` の結果はプロセス内で変わらないのでモジュールスコープでキャッシュする。
let cachedAvailableLocales: string[] | null = null;

/**
 * システムで利用可能なロケール一覧を返す（非Windowsのみ）。
 * `locale -a` を実行できない環境では空配列を返す。
 */
export function getAvailableLocales(): string[] {
  if (process.platform === 'win32') {
    return [];
  }
  if (cachedAvailableLocales !== null) {
    return cachedAvailableLocales;
  }
  try {
    const output = execSync('locale -a', { encoding: 'utf8' });
    cachedAvailableLocales = output
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  } catch {
    cachedAvailableLocales = [];
  }
  return cachedAvailableLocales;
}

/**
 * シェルのベース名を小文字で返す（例: "/bin/zsh" -> "zsh", "powershell.exe" -> "powershell"）。
 */
export function getShellBasename(shell: string): string {
  const base = path.basename(shell).toLowerCase();
  return base.replace(/\.exe$/, '');
}
