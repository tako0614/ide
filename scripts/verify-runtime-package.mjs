import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Frozen file inventory from the installed 3.5.49-combined.20261004.10 package.
// Update deliberately if the runtime package layout changes.
const expectedPaths = [
  "LICENSE",
  "README.md",
  "bin/deckide-computer.js",
  "bin/deckide-desktop-mcp.js",
  "bin/deckide-session.js",
  "bin/deckide-ui.js",
  "bin/deckide.js",
  "dist/agents/claude.js",
  "dist/agents/library.js",
  "dist/agents/localControl.js",
  "dist/agents/opencode.js",
  "dist/agents/processes.js",
  "dist/auth/credentials.js",
  "dist/auth/password.js",
  "dist/codex/library.js",
  "dist/computer/borrowed-desktop.js",
  "dist/computer/catalog.js",
  "dist/computer/chatgpt-controller.js",
  "dist/computer/chatgpt-owner.js",
  "dist/computer/chatgpt-startup.js",
  "dist/computer/descriptor-validation.js",
  "dist/computer/desktop.js",
  "dist/computer/host-session.js",
  "dist/computer/native/launcher-manifest.json",
  "dist/computer/native/vnc-launcher",
  "dist/computer/private-unix.js",
  "dist/computer/rfb.js",
  "dist/computer/stream-tickets.js",
  "dist/computer/system-catalog.js",
  "dist/computer/vnc.js",
  "dist/computer/x-display-collision.js",
  "dist/config.js",
  "dist/desktop/shared-desktop.js",
  "dist/index.js",
  "dist/middleware/auth.js",
  "dist/middleware/cors.js",
  "dist/middleware/origin.js",
  "dist/middleware/security.js",
  "dist/routes/agents.js",
  "dist/routes/browser.js",
  "dist/routes/codex.js",
  "dist/routes/computer.js",
  "dist/routes/decks.js",
  "dist/routes/desktop.js",
  "dist/routes/files.js",
  "dist/routes/git.js",
  "dist/routes/mcp.js",
  "dist/routes/settings.js",
  "dist/routes/terminals.js",
  "dist/routes/workspaces.js",
  "dist/server.js",
  "dist/shared/types.js",
  "dist/shared/utils-node.js",
  "dist/shared/utils.js",
  "dist/terminal/localBridge.js",
  "dist/terminal/parserTail.js",
  "dist/terminal/snapshot.js",
  "dist/terminal/tmuxAdapter.js",
  "dist/terminal/tmuxBroker.js",
  "dist/terminal/tmuxBrokerClient.js",
  "dist/types.js",
  "dist/utils/agent-browser.js",
  "dist/utils/browser-audio.js",
  "dist/utils/browser-maintenance.js",
  "dist/utils/browser-webrtc.js",
  "dist/utils/database.js",
  "dist/utils/error.js",
  "dist/utils/events.js",
  "dist/utils/path.js",
  "dist/utils/shell.js",
  "dist/utils/utf8.js",
  "dist/websocket.js",
  "docs/terminal-tmux.md",
  "npm-shrinkwrap.json",
  "ops/chatgpt-launcher/product/desktop-session.py",
  "ops/chatgpt-launcher/product/launch-chatgpt.sh",
  "ops/chatgpt-launcher/product/session-bus.conf",
  "ops/chatgpt-launcher/product/session-supervisor.py",
  "ops/chatgpt-launcher/product/SOURCE-ADAPTATION.json",
  "ops/chatgpt-launcher/product/test-session-lifecycle.py",
  "ops/chatgpt-launcher/source/app-config.example.toml",
  "ops/chatgpt-launcher/source/desktop-session.py",
  "ops/chatgpt-launcher/source/launch-chatgpt.sh",
  "ops/chatgpt-launcher/source/LAUNCHER-CONTRACT.md",
  "ops/chatgpt-launcher/source/MANIFEST.json",
  "ops/chatgpt-launcher/source/session-bus.conf",
  "ops/chatgpt-launcher/source/session-supervisor.py",
  "ops/chatgpt-launcher/source/SHA256SUMS",
  "ops/chatgpt-launcher/source/test-session-lifecycle.py",
  "ops/desktop/browser.sh",
  "ops/desktop/chrome.sh",
  "ops/desktop/deckide-browser.service",
  "ops/desktop/deckide-desktop.service",
  "ops/desktop/install.sh",
  "ops/desktop/open-tab.mjs",
  "ops/desktop/README.md",
  "ops/desktop/session.sh",
  "ops/desktop/skel/.config/xfce4/xfconf/xfce-perchannel-xml/xfce4-desktop.xml",
  "ops/desktop/skel/.config/xfce4/xfconf/xfce-perchannel-xml/xfce4-panel.xml",
  "ops/desktop/skel/.config/xfce4/xfconf/xfce-perchannel-xml/xfce4-session.xml",
  "ops/desktop/skel/.config/xfce4/xfconf/xfce-perchannel-xml/xfwm4.xml",
  "ops/desktop/skel/.config/xfce4/xfconf/xfce-perchannel-xml/xsettings.xml",
  "ops/desktop/skel/.local/share/applications/chatgpt.desktop",
  "ops/desktop/skel/.local/share/applications/google-chrome.desktop",
  "ops/desktop/skel/.local/share/applications/grok-bot.desktop",
  "ops/desktop/skel/.local/share/xfce4/helpers/deckide-chrome.desktop",
  "ops/README-terminal-update.md",
  "ops/startup-check.mjs",
  "ops/systemd/deckide-tmux-broker.service.tmpl",
  "ops/systemd/deckide.service.d/99-deckide-tmux.conf.tmpl",
  "ops/terminal-update-guards.mjs",
  "ops/terminal-update.mjs",
  "package.json",
  "web/dist/assets/index-BNkvy7tu.css",
  "web/dist/assets/index-DjwNV2M2.js",
  "web/dist/assets/rfb-CxsXsMUX.js",
  "web/dist/index.html"
];
const executablePaths = new Set([
  'bin/deckide.js',
  'dist/computer/native/vnc-launcher',
  'ops/chatgpt-launcher/product/launch-chatgpt.sh',
  'ops/desktop/browser.sh', 'ops/desktop/chrome.sh',
  'ops/desktop/install.sh', 'ops/desktop/session.sh',
]);
const reviewedBinarySha256 = '927ff0b4d21183e008f665d68978f944c2550ea65202ec1462087f7ef31cfeec';
const reviewedSourceSha256 = '92a74d607ec673b72e1eed82bd179e66d92b42d52753a47fddcd77eb0b305105';
const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const normalizedPath = (entry) => entry.replace(
  /^(web\/dist\/assets\/(?:index|rfb))-[A-Za-z0-9_-]{8,}(\.(?:js|css))$/,
  '$1-<fingerprint>$2');

function comparePaths(actual, expected, label) {
  const actualSet = new Set(actual.map(normalizedPath));
  const expectedSet = new Set(expected.map(normalizedPath));
  const missing = [...expectedSet].filter((entry) => !actualSet.has(entry));
  const extra = [...actualSet].filter((entry) => !expectedSet.has(entry));
  if (actual.length !== expected.length || actualSet.size !== actual.length ||
      missing.length || extra.length)
    throw new Error(`${label} differs from the .10 runtime inventory: ` +
      JSON.stringify({ count: actual.length, expectedCount: expected.length, missing, extra }));
}

async function referencePaths(root) {
  const paths = ['LICENSE', 'README.md', 'package.json', 'npm-shrinkwrap.json',
    'docs/terminal-tmux.md'];
  async function walk(relative) {
    for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
      const next = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) await walk(next);
      else if (entry.isFile()) paths.push(next);
      else throw new Error(`Unexpected reference package entry: ${next}`);
    }
  }
  for (const directory of ['bin', 'dist', 'web/dist', 'ops']) await walk(directory);
  return paths;
}

const [tarball, flag, reference] = process.argv.slice(2);
if (!tarball || (flag && (flag !== '--reference' || !reference)) ||
    (reference && !flag) || process.argv.length > (reference ? 5 : 3))
  throw new Error('Usage: verify-runtime-package.mjs <package.tgz> [--reference <installed-package-dir>]');

const { stdout: listing } = await run('tar', ['-tzf', tarball], { maxBuffer: 4 * 1024 * 1024 });
const tarPaths = listing.trimEnd().split('\n');
assert.equal(tarPaths.length, new Set(tarPaths).size, 'duplicate tar entries');
for (const entry of tarPaths)
  assert.match(entry, /^package\/(?!\/)(?!.*(?:^|\/)\.\.?\/)[A-Za-z0-9_.@/+\-]+$/,
    `unsafe tar entry ${entry}`);
const actualPaths = tarPaths.map((entry) => entry.slice('package/'.length));
comparePaths(actualPaths, expectedPaths, 'Packed tarball');

const { stdout: verbose } = await run('tar', ['-tvzf', tarball], { maxBuffer: 4 * 1024 * 1024 });
const modes = new Map();
for (const line of verbose.trimEnd().split('\n')) {
  const match = /^(\S{10}) \S+\s+\d+ \S+ \S+ (package\/.+)$/.exec(line);
  if (!match) throw new Error(`Cannot read tar entry mode: ${line}`);
  const [, mode, name] = match;
  assert.equal(mode[0], '-', `Non-file tar entry: ${name}`);
  modes.set(name.slice('package/'.length), mode);
}
assert.equal(modes.size, expectedPaths.length, 'tar mode inventory differs');
for (const [name, mode] of modes)
  assert.equal(mode.includes('x'), executablePaths.has(name), `executable mode differs: ${name}`);

async function packed(file) {
  const { stdout } = await run('tar', ['-xOzf', tarball, `package/${file}`],
    { encoding: 'buffer', maxBuffer: 4 * 1024 * 1024 });
  return stdout;
}
const sourcePackage = JSON.parse(await readFile(path.join(project, 'package.json'), 'utf8'));
const packageJson = JSON.parse((await packed('package.json')).toString('utf8'));
const shrinkwrap = JSON.parse((await packed('npm-shrinkwrap.json')).toString('utf8'));
assert.equal(packageJson.name, 'deckide');
assert.equal(packageJson.version, sourcePackage.version, 'tarball package version differs from source');
assert.equal(shrinkwrap.version, packageJson.version, 'shrinkwrap top-level version differs');
assert.equal(shrinkwrap.packages[''].version, packageJson.version, 'shrinkwrap root version differs');
assert.equal(shrinkwrap.packages[''].name, packageJson.name);
assert.equal(packageJson.bin.deckide, 'bin/deckide.js');

const binary = await packed('dist/computer/native/vnc-launcher');
const manifest = JSON.parse((await packed('dist/computer/native/launcher-manifest.json')).toString('utf8'));
const reviewedManifest = JSON.parse(await readFile(
  path.join(project, 'src/computer/native/prebuilt/launcher-manifest.json'), 'utf8'));
assert.equal(sha256(binary), reviewedBinarySha256, 'packed launcher differs from reviewed .10 binary');
assert.deepEqual(manifest, reviewedManifest, 'packed launcher manifest differs from reviewed .10 manifest');
assert.equal(manifest.binary.path, 'dist/computer/native/vnc-launcher');
assert.equal(manifest.binary.sha256, reviewedBinarySha256);
assert.equal(manifest.source.path, 'src/computer/native/vnc-launcher.c');
assert.equal(manifest.source.sha256, reviewedSourceSha256);
assert.equal(manifest.platform, 'linux');
assert.equal(manifest.arch, 'x64');

if (reference) {
  const referenceRoot = path.resolve(reference);
  assert.equal((await lstat(referenceRoot)).isDirectory(), true);
  comparePaths(await referencePaths(referenceRoot), expectedPaths, 'Installed reference');
}
console.log(`Verified ${actualPaths.length} packaged files, .10 runtime layout, version ${packageJson.version}, and reviewed native launcher`);
