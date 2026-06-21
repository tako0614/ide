import fs from 'node:fs/promises';

// Linux clock ticks per second. Effectively always 100 on Linux; used only to
// estimate process age, where small drift is harmless.
const CLOCK_HZ = 100;

interface McpReaperOptions {
  cdpPort: number;
  // Max chrome-devtools-mcp stacks one agent may keep before old extras are reaped.
  maxPerAgent: number;
  // Extra stacks must be older than this before being reaped (spares restart bursts).
  idleMs: number;
  intervalMs: number;
}

type ProcInfo = { ppid: number; cmdline: string; ageSec: number };

// Minimal shape the reap planner needs (cmdline is irrelevant to selection).
export interface ReapProc {
  ppid: number;
  ageSec: number;
}

/**
 * Pure selection: given the set of chrome-devtools-mcp processes (node servers +
 * their npm/sh launcher wrappers), return the pids to kill. Exported for testing.
 *
 * A "stack top" is a proc whose parent is not itself in the set (its parent is
 * the agent). Stacks are grouped by agent; for any agent owning more than
 * `maxPerAgent` stacks, the oldest extras beyond the cap — and only those older
 * than `idleMs` — are selected along with their whole subtree. Healthy agents
 * (≤ maxPerAgent stacks) are never touched.
 */
export function planReap(procs: Map<number, ReapProc>, maxPerAgent: number, idleMs: number): number[] {
  const stacksByAgent = new Map<number, number[]>();
  for (const [pid, info] of procs) {
    if (!procs.has(info.ppid)) {
      const list = stacksByAgent.get(info.ppid) ?? [];
      list.push(pid);
      stacksByAgent.set(info.ppid, list);
    }
  }

  const children = new Map<number, number[]>();
  for (const [pid, info] of procs) {
    const list = children.get(info.ppid) ?? [];
    list.push(pid);
    children.set(info.ppid, list);
  }

  const kill: number[] = [];
  for (const tops of stacksByAgent.values()) {
    if (tops.length <= maxPerAgent) {
      continue;
    }
    tops.sort((a, b) => procs.get(b)!.ageSec - procs.get(a)!.ageSec); // oldest first
    for (const top of tops.slice(0, tops.length - maxPerAgent)) {
      if (procs.get(top)!.ageSec * 1000 < idleMs) {
        continue; // spare recent stacks (e.g. mid-restart)
      }
      const queue = [top];
      while (queue.length) {
        const pid = queue.shift()!;
        kill.push(pid);
        for (const child of children.get(pid) ?? []) {
          if (procs.has(child)) queue.push(child);
        }
      }
    }
  }
  return kill;
}

/**
 * Reaps leaked `chrome-devtools-mcp` server stacks.
 *
 * Agents (Claude/Codex) spawn one chrome-devtools-mcp server per session pointed
 * at our shared browser's CDP port. A buggy agent can respawn it on every failure
 * without reaping the old one — we observed a single Codex process holding 66
 * servers (~24 GB) with the agent's active one wedged ("can't use chrome").
 *
 * NOTE: chrome-devtools-mcp connects to the browser lazily (only during a tool
 * call), so "not connected to 9222" does NOT mean "dead" — an idle-but-live
 * session would look disconnected. We therefore key off the actual leak
 * signature instead: when ONE agent process owns more than `maxPerAgent`
 * chrome-devtools-mcp stacks (aimed at our port), the oldest extras beyond the
 * cap that are also older than `idleMs` are killed, keeping the newest (active)
 * ones. A healthy agent with a single MCP is never touched. Linux-only.
 */
export function startMcpReaper(opts: McpReaperOptions): () => void {
  const timer = setInterval(() => {
    void reapOnce(opts).catch(() => undefined);
  }, opts.intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

// All chrome-devtools-mcp processes (node servers + npm/sh launcher wrappers)
// whose cmdline targets our CDP port. Keyed by pid.
async function readMcpProcs(cdpPort: number): Promise<Map<number, ProcInfo>> {
  const procs = new Map<number, ProcInfo>();
  let uptime: number;
  try {
    uptime = parseFloat((await fs.readFile('/proc/uptime', 'utf8')).split(' ')[0]);
  } catch {
    return procs; // not Linux / no procfs
  }
  let pids: string[];
  try {
    pids = (await fs.readdir('/proc')).filter((n) => /^\d+$/.test(n));
  } catch {
    return procs;
  }

  const portToken = `127.0.0.1:${cdpPort}`;
  for (const pid of pids) {
    let cmdline: string;
    try {
      cmdline = (await fs.readFile(`/proc/${pid}/cmdline`, 'utf8')).replace(/\0/g, ' ').trim();
    } catch {
      continue;
    }
    // Target only chrome-devtools-mcp aimed at OUR shared browser.
    if (!cmdline.includes('chrome-devtools-mcp') || !cmdline.includes(portToken)) {
      continue;
    }
    let stat: string;
    try {
      stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
    } catch {
      continue;
    }
    // comm (field 2) is parenthesised and may contain spaces/parens — parse after
    // the final ')'. Then index 1 = ppid (field 4), index 19 = starttime (field 22).
    const after = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const ppid = Number.parseInt(after[1], 10);
    const starttime = Number.parseInt(after[19], 10);
    if (!Number.isFinite(ppid) || !Number.isFinite(starttime)) {
      continue;
    }
    procs.set(Number.parseInt(pid, 10), { ppid, cmdline, ageSec: uptime - starttime / CLOCK_HZ });
  }
  return procs;
}

async function reapOnce(opts: McpReaperOptions): Promise<void> {
  const procs = await readMcpProcs(opts.cdpPort);
  if (procs.size === 0) {
    return;
  }

  const kill = planReap(procs, opts.maxPerAgent, opts.idleMs);
  let reaped = 0;
  for (const pid of kill) {
    try {
      process.kill(pid, 'SIGTERM');
      reaped++;
    } catch {
      // already gone
    }
  }
  if (reaped > 0) {
    console.log(`[browser-maintenance] reaped ${reaped} process(es) from leaked chrome-devtools-mcp stacks`);
  }
}
