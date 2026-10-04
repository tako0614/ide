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

type ProcInfo = { ppid: number; cmdline: string; ageSec: number; inUse?: boolean };

// Minimal shape the reap planner needs (cmdline is irrelevant to selection).
export interface ReapProc {
  ppid: number;
  ageSec: number;
  // Holds an open socket to our CDP port, i.e. the agent is really talking through
  // this server right now. Optional so callers/tests can omit it.
  inUse?: boolean;
}

/**
 * Pure selection: given the set of chrome-devtools-mcp processes (node servers +
 * their npm/sh launcher wrappers), return the pids to kill. Exported for testing.
 *
 * A "stack top" is a proc whose parent is not itself in the set (its parent is
 * the agent). Stacks are grouped by agent; for any agent owning more than
 * `maxPerAgent` stacks, the oldest extras beyond the cap — and only those older
 * than `idleMs` and holding no live CDP socket — are selected along with their
 * whole subtree. Healthy agents (≤ maxPerAgent stacks) are never touched.
 *
 * "Newest wins" alone is not enough: a long-lived agent session keeps using the
 * server it started with and the newer stacks are its failed retry-spawns, so the
 * oldest stack is frequently the live one. `inUse` (an open socket to our CDP
 * port) overrides age in that case.
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
      const subtree: number[] = [];
      const queue = [top];
      while (queue.length) {
        const pid = queue.shift()!;
        subtree.push(pid);
        for (const child of children.get(pid) ?? []) {
          if (procs.has(child)) queue.push(child);
        }
      }
      if (subtree.some((pid) => procs.get(pid)!.inUse)) {
        continue; // the agent is talking through this one — age says otherwise, it wins
      }
      kill.push(...subtree);
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

/**
 * Wall-clock epoch (seconds) of the boot that `/proc/<pid>/stat` starttime counts
 * from, read from `/proc/stat` btime.
 *
 * Deliberately NOT derived from `/proc/uptime`: under LXC/lxcfs (this is how the
 * IDE is deployed on the author's host) `/proc/uptime` is virtualised to the
 * CONTAINER's uptime while starttime still counts from the HOST's boot. The old
 * `uptime - starttime/HZ` therefore produced large NEGATIVE ages, every stack
 * looked brand new, and the reaper spared all of them forever — 14 leaked stacks
 * / 5.7 GB accumulated with the reaper enabled and running.
 */
async function readBootEpochSec(): Promise<number | null> {
  try {
    const stat = await fs.readFile('/proc/stat', 'utf8');
    const match = /^btime\s+(\d+)$/m.exec(stat);
    if (match) {
      const btime = Number.parseInt(match[1], 10);
      if (Number.isFinite(btime)) return btime;
    }
  } catch {
    // not Linux / no procfs
  }
  return null;
}

// All chrome-devtools-mcp processes belonging to a stack aimed at our CDP port —
// npm/sh launcher wrappers plus the node server underneath. Keyed by pid.
async function readMcpProcs(cdpPort: number): Promise<Map<number, ProcInfo>> {
  const procs = new Map<number, ProcInfo>();
  const bootEpochSec = await readBootEpochSec();
  if (bootEpochSec === null) {
    return procs; // cannot age processes safely — do nothing rather than guess
  }
  let pids: string[];
  try {
    pids = (await fs.readdir('/proc')).filter((n) => /^\d+$/.test(n));
  } catch {
    return procs;
  }

  const nowSec = Date.now() / 1000;
  const portToken = `127.0.0.1:${cdpPort}`;
  // Pass 1: every chrome-devtools-mcp process, whether or not its cmdline still
  // names our port. The MCP server sets `process.title` to "chrome-devtools-mcp",
  // which overwrites its argv — `--browserUrl http://127.0.0.1:9222` disappears
  // from /proc/<pid>/cmdline. Requiring the port token therefore matched only the
  // npm/sh wrappers, so a reap killed those and orphaned the 150 MB–1.4 GB node
  // server they wrapped, which then leaked with no parent left to attribute it to.
  const candidates = new Map<number, ProcInfo & { targetsPort: boolean }>();
  for (const pid of pids) {
    let cmdline: string;
    try {
      cmdline = (await fs.readFile(`/proc/${pid}/cmdline`, 'utf8')).replace(/\0/g, ' ').trim();
    } catch {
      continue;
    }
    if (!cmdline.includes('chrome-devtools-mcp')) {
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
    candidates.set(Number.parseInt(pid, 10), {
      ppid,
      cmdline,
      ageSec: nowSec - (bootEpochSec + starttime / CLOCK_HZ),
      targetsPort: cmdline.includes(portToken),
    });
  }

  // Pass 2: keep the stacks aimed at OUR browser, plus their descendants, so each
  // stack is reaped whole. A title-clobbered server is claimed by lineage only —
  // an MCP pointed at some other browser is never adopted.
  for (const [pid, info] of candidates) {
    if (info.targetsPort) procs.set(pid, info);
  }
  for (let grew = true; grew; ) {
    grew = false;
    for (const [pid, info] of candidates) {
      if (!procs.has(pid) && procs.has(info.ppid)) {
        procs.set(pid, info);
        grew = true;
      }
    }
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
