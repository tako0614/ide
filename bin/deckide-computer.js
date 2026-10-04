import fs from 'node:fs';

function temporaryToken() {
  const fdText = process.env.DECKIDE_MCP_ACCESS_TOKEN_FD;
  let token;
  if (fdText !== undefined) {
    const fd = Number(fdText);
    if (!Number.isInteger(fd) || fd < 3) throw new Error('Invalid temporary token FD');
    const input = fs.readFileSync(fd);
    if (input.length > 4096) throw new Error('Temporary token is too large');
    token = input.toString('utf8').trim();
  } else token = process.env.DECKIDE_MCP_ACCESS_TOKEN;
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token))
    throw new Error('A temporary MCP OAuth bearer is required via DECKIDE_MCP_ACCESS_TOKEN_FD or DECKIDE_MCP_ACCESS_TOKEN');
  return token;
}

function inheritedMcpUrl() {
  const raw = process.env.DECKIDE_COMPUTER_MCP_URL;
  if (!raw) throw new Error('This terminal has no host-issued computer session');
  const url = new URL(raw);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    url.pathname !== '/mcp' || url.username || url.password || url.search || url.hash)
    throw new Error('Invalid host-issued MCP endpoint');
  return url.href;
}

function optionValues(args, allowed) {
  const values = new Map();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    if (!allowed.includes(key) || args[i + 1] === undefined ||
      (key !== '--arg' && (!args[i + 1] || args[i + 1].startsWith('--'))))
      throw new Error('Invalid computer command options');
    const all = values.get(key) ?? [];
    if (key !== '--arg' && all.length) throw new Error('Duplicate computer command option');
    all.push(args[i + 1]);
    values.set(key, all);
  }
  return { one: (key) => values.get(key)?.[0], all: (key) => values.get(key) ?? [] };
}

export async function runComputerClient(args) {
  const [action, ...rest] = args;
  if (!['bind', 'apps', 'prepare', 'register', 'launch'].includes(action))
    throw new Error('Usage: deckide computer bind|apps|prepare|register|launch');
  const url = inheritedMcpUrl();
  const token = temporaryToken();
  const call = async (name, values = {}) => {
    const response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: `deckide.computer.${name}`, arguments: values } }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`MCP request failed (${response.status})`);
    const message = await response.json();
    if (message.error) throw new Error(message.error.message || 'MCP protocol error');
    const result = message.result;
    if (!result || result.isError) throw new Error(result?.structuredContent?.error || 'Computer command failed');
    return result.structuredContent;
  };

  let result;
  if (action === 'bind') {
    if (rest.length) throw new Error('bind takes no arguments');
    const capability = process.env.DECKIDE_COMPUTER_SESSION_CAPABILITY;
    if (!capability) throw new Error('This PTY has no unconsumed host session capability');
    result = await call('bind_session', { capability });
    delete process.env.DECKIDE_COMPUTER_SESSION_CAPABILITY;
  } else if (action === 'apps' || action === 'prepare') {
    if (rest.length) throw new Error(`${action} takes no arguments`);
    result = await call(action);
  } else if (action === 'register') {
    const opts = optionValues(rest, ['--executable', '--cwd', '--arg', '--args-json']);
    const executable = opts.one('--executable');
    if (!executable) throw new Error('register requires --executable');
    if (opts.one('--args-json') && opts.all('--arg').length)
      throw new Error('Use either --args-json or repeated --arg');
    let argv = opts.all('--arg');
    if (opts.one('--args-json')) {
      try { argv = JSON.parse(opts.one('--args-json')); }
      catch { throw new Error('--args-json must be a JSON string array'); }
    }
    if (!Array.isArray(argv) || argv.length > 32 ||
      argv.some((value) => typeof value !== 'string' || value.length > 512 || value.includes('\0')))
      throw new Error('Invalid developed app argument array');
    const catalog = await call('apps');
    const scopes = catalog?.developmentScopes?.filter((scope) => scope.id.startsWith('host:')) ?? [];
    if (scopes.length !== 1) throw new Error('Exactly one live host session scope is required');
    result = await call('register', { scopeId: scopes[0].id, executable,
      cwd: opts.one('--cwd') ?? '.', args: argv });
  } else {
    const opts = optionValues(rest, ['--app', '--url']);
    const app = opts.one('--app');
    if (!app) throw new Error('launch requires --app');
    result = await call('launch', { app, ...(opts.one('--url') ? { url: opts.one('--url') } : {}) });
  }
  process.stdout.write(JSON.stringify(result) + '\n');
}
