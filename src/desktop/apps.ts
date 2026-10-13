import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export type DesktopApp = {
  /** .desktop file name without the extension (user entries override system ones). */
  id: string;
  name: string;
  comment?: string;
  /** Command line with field codes (%U, %f, …) removed. */
  exec: string[];
  /** Chromium/Electron based: needs --no-sandbox when running as root. */
  chromium: boolean;
};

function applicationDirs(extra: string[] = []): string[] {
  const dataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  const dataDirs = (process.env.XDG_DATA_DIRS || '/usr/local/share:/usr/share').split(':').filter(Boolean);
  // Highest priority last, so later entries override earlier ones by id.
  return [...dataDirs.reverse(), dataHome].map((dir) => path.join(dir, 'applications')).concat(extra);
}

/** Unescape a desktop-entry string value (\s \n \t \r \\). */
function unescapeValue(value: string): string {
  return value.replace(/\\([sntr\\])/g, (_, c: string) =>
    c === 's' ? ' ' : c === 'n' ? '\n' : c === 't' ? '\t' : c === 'r' ? '\r' : '\\');
}

/**
 * Split an Exec value per the Desktop Entry spec: double-quoted arguments
 * (with \" \` \$ \\ escapes), field codes removed, %% kept as %.
 */
export function parseExec(value: string): string[] {
  const args: string[] = [];
  let current = '';
  let inQuotes = false;
  let hasToken = false;
  const input = unescapeValue(value);
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (inQuotes) {
      if (char === '\\' && i + 1 < input.length && '"`$\\'.includes(input[i + 1])) {
        current += input[++i];
      } else if (char === '"') {
        inQuotes = false;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"') {
      inQuotes = true;
      hasToken = true;
    } else if (char === ' ' || char === '\t') {
      if (hasToken) args.push(current);
      current = '';
      hasToken = false;
    } else {
      current += char;
      hasToken = true;
    }
  }
  if (hasToken) args.push(current);
  return args
    // A bare field code (file/URL placeholders, icon, name…) is an argument
    // we have no value for: drop it. Codes inside an argument are removed.
    .filter((arg) => !/^%[fFuUdDnNickvm]$/.test(arg))
    .map((arg) => arg.replace(/%%|%[fFuUdDnNickvm]/g, (code) => (code === '%%' ? '%' : '')));
}

function resolveProgram(exec: string[]): string | null {
  // Skip an `env VAR=value …` prefix.
  let index = 0;
  if (path.basename(exec[0] ?? '') === 'env') {
    index = 1;
    while (index < exec.length && exec[index].includes('=')) index++;
  }
  const program = exec[index];
  if (!program) return null;
  const candidates = path.isAbsolute(program)
    ? [program]
    : (process.env.PATH ?? '/usr/bin:/bin').split(path.delimiter).map((dir) => path.join(dir, program));
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return fs.realpathSync(candidate);
    } catch { /* next */ }
  }
  return null;
}

function isChromiumLike(program: string | null): boolean {
  if (!program) return false;
  if (/(^|\/)(google-chrome[^/]*|chromium[^/]*|chrome|electron)$/.test(program)) return true;
  // Electron and Chromium ship their setuid sandbox helper next to the binary.
  return fs.existsSync(path.join(path.dirname(program), 'chrome-sandbox'));
}

function parseDesktopFile(content: string): Record<string, string> | null {
  const entries: Record<string, string> = {};
  let inMain = false;
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('[')) {
      inMain = line === '[Desktop Entry]';
      continue;
    }
    if (!inMain) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!(key in entries)) entries[key] = line.slice(eq + 1).trim();
  }
  return Object.keys(entries).length ? entries : null;
}

function localized(entries: Record<string, string>, key: string): string | undefined {
  const lang = (process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || '').split('.')[0];
  const short = lang.split('_')[0];
  return entries[`${key}[${lang}]`] ?? entries[`${key}[${short}]`] ?? entries[`${key}[ja]`] ?? entries[key];
}

/** GUI apps from the standard .desktop directories (Terminal=true and hidden entries excluded). */
export async function listDesktopApps(extraDirs: string[] = []): Promise<DesktopApp[]> {
  const byId = new Map<string, DesktopApp>();
  for (const dir of applicationDirs(extraDirs)) {
    let names: string[];
    try {
      names = (await fsp.readdir(dir)).filter((name) => name.endsWith('.desktop'));
    } catch {
      continue;
    }
    for (const fileName of names) {
      const id = fileName.slice(0, -'.desktop'.length);
      let content: string;
      try {
        content = await fsp.readFile(path.join(dir, fileName), 'utf8');
      } catch {
        continue;
      }
      const entries = parseDesktopFile(content);
      if (!entries || entries.Type !== 'Application' || !entries.Exec) {
        byId.delete(id);
        continue;
      }
      if (entries.NoDisplay === 'true' || entries.Hidden === 'true' || entries.Terminal === 'true') {
        byId.delete(id);
        continue;
      }
      const exec = parseExec(entries.Exec);
      if (exec.length === 0) continue;
      const program = resolveProgram(exec);
      if (entries.TryExec && !resolveProgram([entries.TryExec])) {
        byId.delete(id);
        continue;
      }
      if (!program) continue;
      byId.set(id, {
        id,
        name: localized(entries, 'Name') || id,
        comment: localized(entries, 'Comment'),
        exec,
        chromium: isChromiumLike(program),
      });
    }
  }
  return Array.from(byId.values()).sort((a, b) => a.name.localeCompare(b.name));
}
