import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

export type SystemDesktopApp = { id: `system:${string}`; label: string; command: string; args: string[] };
const SYSTEM_DIRS = ['/usr/share/applications', '/usr/local/share/applications'];
const SAFE_BIN_DIRS = ['/usr/local/bin', '/usr/bin', '/bin'];
const INTERPRETERS = new Set(['sh', 'bash', 'dash', 'zsh', 'fish', 'python', 'python3', 'node', 'perl', 'ruby', 'env']);
const BROWSERS = /(?:browser|chrom(?:e|ium)|firefox|brave|vivaldi|opera|epiphany|qutebrowser)/i;
const REMOTE_ACCESS_SERVERS = /^(?:x11vnc|x0vncserver|xvnc|xtigervnc|vncserver(?:-x11|-virtual)?|tigervncserver|wayvnc|xrdp(?:-sesman)?|sshd|dropbear|vino-server|gnome-remote-desktop-daemon|krfb)$/i;
const DAEMON_FLAGS = new Set(['-bg', '-daemon', '--daemon', '--daemonize', '--background',
  '-listen', '--listen', '-server', '--server', '--serve', '--serve-web', '-rfbport', '-httpport']);

/** Excludes known remote-access servers and listener flags; this is not network confinement. */
export function allowedSystemDesktopCommand(command: string, args: string[], _categories = ''): boolean {
  const base = path.basename(command);
  if (BROWSERS.test(base) || REMOTE_ACCESS_SERVERS.test(base)) return false;
  if (args.some((arg) => DAEMON_FLAGS.has(arg) || /^--(?:listen|port|bind|host|server)(?:=|$)/.test(arg))) return false;
  return true;
}

async function trustedDirectory(directory: string): Promise<boolean> {
  let current = directory;
  for (;;) {
    const stat = await fs.stat(current);
    if (!stat.isDirectory() || stat.uid !== 0 || (stat.mode & 0o022)) return false;
    if (current === '/') break;
    current = path.dirname(current);
  }
  return true;
}

export function parseDesktopExec(value: string): string[] | null {
  if (value.length > 2048 || /[\x00-\x08\x0b-\x1f\x7f\r\n]/.test(value)) return null;
  const words: Array<{ value: string; quoted: boolean }> = [];
  let current = '';
  let quoted = false;
  let wasQuoted = false;
  let active = false;
  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    if (char === '"') { quoted = !quoted; wasQuoted = true; active = true; continue; }
    if (char === '\\') {
      if (!quoted) return null;
      const next = value[++index];
      if (!next || !['"', '\\', '$', '`'].includes(next)) return null;
      current += next;
      active = true;
      continue;
    }
    if (/\s/.test(char) && !quoted) {
      if (active) { words.push({ value: current, quoted: wasQuoted }); current = ''; active = false; wasQuoted = false; }
      continue;
    }
    if (!quoted && !/[A-Za-z0-9_./:+,=@%-]/.test(char)) return null;
    current += char;
    active = true;
  }
  if (quoted) return null;
  if (active) words.push({ value: current, quoted: wasQuoted });
  if (!words.length || words.length > 24 || words.some((word) => word.value.length > 512)) return null;
  let fileCodeCount = 0;
  const result: string[] = [];
  for (const [index, word] of words.entries()) {
    if (word.quoted && word.value.includes('%')) return null;
    if (['%f', '%F', '%u', '%U'].includes(word.value)) {
      if (index === 0 || ++fileCodeCount > 1) return null;
      continue;
    }
    const expanded = word.value.replaceAll('%%', '\u0001');
    if (expanded.includes('%')) return null;
    result.push(expanded.replaceAll('\u0001', '%'));
  }
  return result.length ? result : null;
}

export async function trustedBinary(name: string): Promise<string | null> {
  if (name.includes('/') && !path.isAbsolute(name)) return null;
  const candidates = path.isAbsolute(name) ? [name] : SAFE_BIN_DIRS.map((dir) => path.join(dir, name));
  for (const candidate of candidates) {
    try {
      const resolved = await fs.realpath(candidate);
      if (!(await trustedDirectory(path.dirname(resolved)))) continue;
      const stat = await fs.stat(resolved);
      if (!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o6022) || !(stat.mode & 0o111)) continue;
      if (INTERPRETERS.has(path.basename(resolved))) continue;
      await fs.access(resolved, constants.X_OK);
      return resolved;
    } catch { /* next */ }
  }
  return null;
}

/** A narrow, read-only subset of trusted OS desktop entries. Unsupported entries are omitted. */
export async function systemDesktopApps(): Promise<SystemDesktopApp[]> {
  const apps: SystemDesktopApp[] = [];
  for (const directory of SYSTEM_DIRS) {
    try { if (!(await trustedDirectory(directory))) continue; } catch { continue; }
    let names: string[];
    try { names = (await fs.readdir(directory)).filter((name) => /^[\w.+-]+\.desktop$/.test(name)).sort().slice(0, 256); }
    catch { continue; }
    for (const name of names) {
    const file = path.join(directory, name);
    try {
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o022) || stat.size > 32_768) continue;
      const raw = await fs.readFile(file, 'utf8');
      const main = raw.split(/^\[Desktop Entry\]\s*$/m)[1]?.split(/^\[/m)[0];
      if (!main) continue;
      const fields = new Map<string, string>();
      for (const line of main.split(/\r?\n/)) {
        const split = line.indexOf('=');
        if (split > 0 && !fields.has(line.slice(0, split)))
          fields.set(line.slice(0, split), line.slice(split + 1));
      }
      if (fields.get('Type') !== 'Application' || fields.get('Hidden') === 'true' ||
        fields.get('NoDisplay') === 'true' || fields.get('Terminal') === 'true' ||
        fields.has('DBusActivatable') || fields.has('Path')) continue;
      const label = fields.get('Name');
      const words = parseDesktopExec(fields.get('Exec') ?? '');
      if (!label || label.length > 128 || !words) continue;
      if (INTERPRETERS.has(path.basename(words[0])) || words[0] === 'flatpak' || words[0] === 'snap') continue;
      if (words.some((word) => word === '--no-sandbox' || word.startsWith('--no-sandbox='))) continue;
      if (fields.has('TryExec') && !(await trustedBinary(fields.get('TryExec')!))) continue;
      const command = await trustedBinary(words[0]);
      if (!command) continue;
      if (!allowedSystemDesktopCommand(command, words.slice(1), fields.get('Categories') ?? '')) continue;
      apps.push({ id: `system:${createHash('sha256').update(file).digest('hex')}`,
        label, command, args: words.slice(1) });
    } catch { /* changed or malformed entry */ }
    }
  }
  return apps;
}
