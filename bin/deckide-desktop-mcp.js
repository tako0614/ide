/**
 * `deckide desktop mcp`: a stdio MCP server that lets an agent (Grok Bot,
 * Claude Code, Codex…) see and operate the shared XFCE desktop (ops/desktop)
 * that the web UI shows. Screenshots via ImageMagick `import`, input via xdotool.
 *
 * Coordinates are in screenshot pixels; screenshots larger than MAX_WIDTH x
 * MAX_HEIGHT are scaled down and every call maps back with the current scale.
 */
import { execFile, spawn } from 'node:child_process';
import readline from 'node:readline';

const MAX_WIDTH = 1280;
const MAX_HEIGHT = 800;
const MAX_TEXT = 4000;
const BUTTONS = { left: 1, middle: 2, right: 3 };
const SCROLL_BUTTONS = { up: 4, down: 5, left: 6, right: 7 };

function desktopEnv(env = process.env) {
  return {
    ...env,
    DISPLAY: env.DECKIDE_DESKTOP_DISPLAY || ':99',
    XAUTHORITY: env.DECKIDE_DESKTOP_XAUTHORITY || '/run/deckide-desktop/Xauthority',
  };
}

function run(file, args, { encoding = 'utf8', timeout = 15_000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { env: desktopEnv(), encoding, timeout, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(String(stderr || error.message).trim().split('\n')[0] || 'command failed'));
      else resolve(stdout);
    });
  });
}

export function screenshotScale(width, height) {
  return Math.min(1, MAX_WIDTH / width, MAX_HEIGHT / height);
}

async function geometry() {
  const [width, height] = (await run('xdotool', ['getdisplaygeometry'])).trim().split(/\s+/).map(Number);
  if (!width || !height) throw new Error('The desktop is not running (deckide-desktop.service).');
  return { width, height, scale: screenshotScale(width, height) };
}

function number(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative number`);
  return value;
}

/** Screenshot pixels → real screen pixels, clamped to the screen. */
async function toScreen(x, y) {
  const { width, height, scale } = await geometry();
  return [
    String(Math.min(width - 1, Math.round(number(x, 'x') / scale))),
    String(Math.min(height - 1, Math.round(number(y, 'y') / scale))),
  ];
}

const point = { x: { type: 'number', description: 'X in screenshot pixels' }, y: { type: 'number', description: 'Y in screenshot pixels' } };

export const TOOLS = [
  {
    name: 'desktop_screenshot',
    description: 'Capture the shared Linux desktop (XFCE: taskbar at the bottom, start menu bottom-left). Coordinates for the other tools are pixels of this screenshot.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'desktop_click',
    description: 'Move the mouse to (x, y) and click.',
    inputSchema: { type: 'object', properties: { ...point,
      button: { type: 'string', enum: ['left', 'right', 'middle'], default: 'left' },
      double: { type: 'boolean', description: 'Double-click', default: false } }, required: ['x', 'y'], additionalProperties: false },
  },
  {
    name: 'desktop_move',
    description: 'Move the mouse to (x, y) without clicking (hover).',
    inputSchema: { type: 'object', properties: point, required: ['x', 'y'], additionalProperties: false },
  },
  {
    name: 'desktop_drag',
    description: 'Press the left button at (from_x, from_y), move to (to_x, to_y) and release.',
    inputSchema: { type: 'object', properties: {
      from_x: { type: 'number' }, from_y: { type: 'number' }, to_x: { type: 'number' }, to_y: { type: 'number' },
    }, required: ['from_x', 'from_y', 'to_x', 'to_y'], additionalProperties: false },
  },
  {
    name: 'desktop_scroll',
    description: 'Scroll at (x, y).',
    inputSchema: { type: 'object', properties: { ...point,
      direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
      amount: { type: 'integer', minimum: 1, maximum: 30, default: 3 } }, required: ['x', 'y', 'direction'], additionalProperties: false },
  },
  {
    name: 'desktop_type',
    description: 'Type text into the focused window (any language, including Japanese).',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
  },
  {
    name: 'desktop_key',
    description: 'Press a key or chord, xdotool syntax: "Return", "Escape", "Tab", "ctrl+l", "ctrl+shift+t", "alt+F4", "super". Several separated by spaces are pressed in order.',
    inputSchema: { type: 'object', properties: { keys: { type: 'string' } }, required: ['keys'], additionalProperties: false },
  },
  {
    name: 'desktop_open',
    description: 'Open a URL, file or folder on the desktop with its default app (web pages open in Chrome).',
    inputSchema: { type: 'object', properties: { target: { type: 'string' } }, required: ['target'], additionalProperties: false },
  },
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function callTool(name, args = {}) {
  switch (name) {
    case 'desktop_screenshot': {
      const { width, height, scale } = await geometry();
      const w = Math.round(width * scale);
      const h = Math.round(height * scale);
      const image = await run('import', ['-window', 'root', ...(scale < 1 ? ['-resize', `${w}x${h}!`] : []), '-quality', '80', 'jpeg:-'],
        { encoding: 'buffer', timeout: 20_000 });
      return [
        { type: 'image', data: image.toString('base64'), mimeType: 'image/jpeg' },
        { type: 'text', text: `Screenshot ${w}x${h} (desktop ${width}x${height}). Use screenshot pixels for coordinates.` },
      ];
    }
    case 'desktop_click': {
      const button = BUTTONS[args.button ?? 'left'];
      if (!button) throw new Error('button must be left, right or middle');
      const [x, y] = await toScreen(args.x, args.y);
      await run('xdotool', ['mousemove', '--sync', x, y, 'click', ...(args.double ? ['--repeat', '2', '--delay', '80'] : []), String(button)]);
      return `Clicked ${args.button ?? 'left'}${args.double ? ' (double)' : ''} at ${args.x},${args.y}.`;
    }
    case 'desktop_move': {
      const [x, y] = await toScreen(args.x, args.y);
      await run('xdotool', ['mousemove', '--sync', x, y]);
      return `Moved to ${args.x},${args.y}.`;
    }
    case 'desktop_drag': {
      const [x1, y1] = await toScreen(args.from_x, args.from_y);
      const [x2, y2] = await toScreen(args.to_x, args.to_y);
      await run('xdotool', ['mousemove', '--sync', x1, y1, 'mousedown', '1']);
      await sleep(80);
      await run('xdotool', ['mousemove', '--sync', x2, y2]);
      await sleep(80);
      await run('xdotool', ['mouseup', '1']);
      return `Dragged from ${args.from_x},${args.from_y} to ${args.to_x},${args.to_y}.`;
    }
    case 'desktop_scroll': {
      const button = SCROLL_BUTTONS[args.direction];
      if (!button) throw new Error('direction must be up, down, left or right');
      const amount = Math.max(1, Math.min(30, Math.round(args.amount ?? 3)));
      const [x, y] = await toScreen(args.x, args.y);
      await run('xdotool', ['mousemove', '--sync', x, y, 'click', '--repeat', String(amount), '--delay', '30', String(button)]);
      return `Scrolled ${args.direction} ${amount} at ${args.x},${args.y}.`;
    }
    case 'desktop_type': {
      if (typeof args.text !== 'string' || !args.text || args.text.length > MAX_TEXT) throw new Error(`text must be 1-${MAX_TEXT} characters`);
      await run('xdotool', ['type', '--delay', '12', '--', args.text], { timeout: 120_000 });
      return `Typed ${args.text.length} characters.`;
    }
    case 'desktop_key': {
      const keys = typeof args.keys === 'string' ? args.keys.trim() : '';
      if (!/^[A-Za-z0-9_+\-]+( [A-Za-z0-9_+\-]+)*$/.test(keys) || keys.length > 200) throw new Error('keys must look like "ctrl+l" or "Return"');
      await run('xdotool', ['key', '--clearmodifiers', '--', ...keys.split(' ')]);
      return `Pressed ${keys}.`;
    }
    case 'desktop_open': {
      const target = typeof args.target === 'string' ? args.target.trim() : '';
      if (!target || target.length > 4096 || target.startsWith('-')) throw new Error('target must be a URL or path');
      await geometry();
      spawn('xdg-open', [target], { env: desktopEnv(), detached: true, stdio: 'ignore' }).unref();
      return `Opening ${target}.`;
    }
    default:
      throw Object.assign(new Error(`Unknown tool: ${name}`), { code: -32602 });
  }
}

export async function handleMessage(message) {
  const { id, method, params } = message ?? {};
  const reply = (result) => (id === undefined ? null : { jsonrpc: '2.0', id, result });
  switch (method) {
    case 'initialize':
      return reply({
        protocolVersion: params?.protocolVersion || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'deckide-desktop', version: '1.0.0' },
        instructions: 'Operate the shared Linux desktop that Deck IDE shows in its デスクトップ pane. Take a screenshot first, then act with screenshot coordinates.',
      });
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: TOOLS });
    case 'tools/call': {
      try {
        const result = await callTool(params?.name, params?.arguments ?? {});
        return reply({ content: Array.isArray(result) ? result : [{ type: 'text', text: result }] });
      } catch (error) {
        if (error.code === -32602) return { jsonrpc: '2.0', id, error: { code: -32602, message: error.message } };
        return reply({ content: [{ type: 'text', text: error.message || String(error) }], isError: true });
      }
    }
    default:
      if (id === undefined || method?.startsWith('notifications/')) return null;
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
  }
}

export async function runDesktopMcp() {
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  const write = (value) => { if (value) process.stdout.write(JSON.stringify(value) + '\n'); };
  // One action at a time, in order: clicks and keystrokes must not interleave.
  let queue = Promise.resolve();
  for await (const line of lines) {
    if (!line.trim()) continue;
    let message;
    try { message = JSON.parse(line); }
    catch { write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); continue; }
    queue = queue.then(() => handleMessage(message)).then(write, (error) => write({ jsonrpc: '2.0', id: message.id ?? null,
      error: { code: -32603, message: error?.message || 'Internal error' } }));
  }
  await queue;
}
