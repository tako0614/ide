import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Deck, TerminalSession, Workspace } from '../types.js';
import type { DevelopmentScope } from './desktop.js';

const CAPABILITY_MS = 60_000;
const MAX_SESSIONS = 32;

export type HostSessionCreator =
  | { kind: 'browser'; sessionKey: string }
  | { kind: 'oauth'; actor: string; issuerSessionKey: string };
export type HostProcessIdentity = { start: string; cwd: string };
type Record_ = {
  terminalId: string;
  terminal?: TerminalSession;
  deck: Deck;
  workspace: Workspace;
  root: string;
  rootDev: number;
  rootIno: number;
  creator: HostSessionCreator;
  capabilityHash: string | null;
  capabilityExpiresAt: number;
  pid?: number;
  start?: string;
  actor?: string;
  grantExpiresAt?: number;
  issuerSessionKey?: string;
  unsubscribe?: () => void;
};

function withinRoot(file: string, root: string): boolean {
  const relative = path.relative(root, file);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative));
}

/** Read only the PTY child PID supplied by node-pty; never discover host processes. */
export function inspectHostPty(pid: number): HostProcessIdentity | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const rest = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
    const start = rest[19]; // Linux field 22, after pid and comm.
    const cwd = fs.realpathSync(`/proc/${pid}/cwd`);
    return start && /^\d+$/.test(start) ? { start, cwd } : null;
  } catch { return null; }
}

function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }

/**
 * Ephemeral authority from an explicitly pinned host CLI startup directory.
 * Terminal and workspace IDs are provenance checks, never root selectors.
 */
export class HostComputerSessions {
  readonly root: string;
  private readonly rootDev: number;
  private readonly rootIno: number;
  private readonly records = new Map<string, Record_>();
  private readonly byActor = new Map<string, string>();
  private readonly now: () => number;
  private readonly inspect: (pid: number) => HostProcessIdentity | null;
  private readonly onRevoked: (actor: string, scopeId: string) => void;
  private readonly onIssuerRevoked: (key: string, callback: () => void) => () => void;
  private readonly grantAlive: (actor: string, issuer: string, expiresAt: number) => boolean;
  private readonly workspaces: Map<string, Workspace>;
  private readonly decks: Map<string, Deck>;
  private readonly terminals: Map<string, TerminalSession>;

  constructor(options: {
    root: string;
    workspaces: Map<string, Workspace>;
    decks: Map<string, Deck>;
    terminals: Map<string, TerminalSession>;
    onRevoked: (actor: string, scopeId: string) => void;
    onIssuerRevoked: (key: string, callback: () => void) => () => void;
    grantAlive: (actor: string, issuer: string, expiresAt: number) => boolean;
    inspect?: (pid: number) => HostProcessIdentity | null;
    now?: () => number;
  }) {
    if (!path.isAbsolute(options.root) || options.root.includes('\0'))
      throw new Error('Computer host-session root must be an absolute directory');
    this.root = fs.realpathSync(options.root);
    if (this.root === path.parse(this.root).root)
      throw new Error('Computer host-session root must be a bounded workspace directory');
    const stat = fs.statSync(this.root);
    if (!stat.isDirectory()) throw new Error('Computer host-session root is not a directory');
    this.rootDev = stat.dev;
    this.rootIno = stat.ino;
    this.workspaces = options.workspaces;
    this.decks = options.decks;
    this.terminals = options.terminals;
    this.onRevoked = options.onRevoked;
    this.onIssuerRevoked = options.onIssuerRevoked;
    this.grantAlive = options.grantAlive;
    this.inspect = options.inspect ?? inspectHostPty;
    this.now = options.now ?? Date.now;
  }

  private scopeId(terminalId: string): string { return `host:${terminalId}`; }

  private sameRoot(candidate: string): boolean {
    try {
      const root = fs.realpathSync(candidate);
      const stat = fs.statSync(root);
      return root === this.root && stat.isDirectory() && stat.dev === this.rootDev &&
        stat.ino === this.rootIno;
    } catch { return false; }
  }

  /** Called only by the host's terminal-spawn path, before the PTY child exists. */
  issueForTerminal(terminalId: string, deck: Deck, creator: HostSessionCreator): string | null {
    this.audit();
    if (this.records.size >= MAX_SESSIONS || this.records.has(terminalId) ||
      !/^[a-f0-9-]{36}$/.test(terminalId) ||
      !(creator.kind === 'browser' ? /^[a-f0-9]{64}$/.test(creator.sessionKey) :
        /^oauth:[a-f0-9]{64}$/.test(creator.actor) && /^[a-f0-9]{64}$/.test(creator.issuerSessionKey)))
      return null;
    const workspace = this.workspaces.get(deck.workspaceId);
    if (!workspace || this.decks.get(deck.id) !== deck ||
      !this.sameRoot(deck.root) || !this.sameRoot(workspace.path)) return null;
    const capability = randomBytes(32).toString('base64url');
    this.records.set(terminalId, {
      terminalId, deck, workspace, root: this.root, rootDev: this.rootDev,
      rootIno: this.rootIno, creator, capabilityHash: hash(capability),
      capabilityExpiresAt: this.now() + CAPABILITY_MS,
    });
    return capability;
  }

  /** Activate only after the terminal map contains the actual host-spawned PTY. */
  activateTerminal(terminalId: string, pid: number, terminal: TerminalSession): boolean {
    const record = this.records.get(terminalId);
    const identity = this.inspect(pid);
    if (!record || this.terminals.get(terminalId) !== terminal ||
      (identity && !withinRoot(identity.cwd, this.root))) {
      this.revokeTerminal(terminalId);
      return false;
    }
    // node-pty may return a PID just before /proc exposes its cwd. The caller
    // retries briefly; no capability can bind until this identity is recorded.
    if (!identity) return false;
    record.terminal = terminal;
    record.pid = pid;
    record.start = identity.start;
    return true;
  }

  private valid(record: Record_): boolean {
    if (!record.terminal || !record.pid || !record.start ||
      this.terminals.get(record.terminalId) !== record.terminal ||
      this.decks.get(record.deck.id) !== record.deck ||
      this.workspaces.get(record.workspace.id) !== record.workspace ||
      record.deck.workspaceId !== record.workspace.id ||
      !this.sameRoot(record.deck.root) || !this.sameRoot(record.workspace.path) ||
      !this.sameRoot(record.root)) return false;
    const identity = this.inspect(record.pid);
    if (!identity || identity.start !== record.start || !withinRoot(identity.cwd, record.root)) return false;
    if (record.actor && (!record.issuerSessionKey || !record.grantExpiresAt ||
      record.grantExpiresAt <= this.now() ||
      !this.grantAlive(record.actor, record.issuerSessionKey, record.grantExpiresAt))) return false;
    return true;
  }

  bind(actor: string, capability: string, grantExpiresAt: number, issuerSessionKey: string):
    { scopeId: string; expiresAt: number } {
    if (!/^oauth:[a-f0-9]{64}$/.test(actor) ||
      !/^[A-Za-z0-9_-]{43}$/.test(capability) ||
      !/^[a-f0-9]{64}$/.test(issuerSessionKey) ||
      !Number.isFinite(grantExpiresAt) || grantExpiresAt <= this.now() ||
      !this.grantAlive(actor, issuerSessionKey, grantExpiresAt))
      throw new Error('Invalid host-session binding');
    this.audit();
    const digest = hash(capability);
    const record = [...this.records.values()].find((item) => item.capabilityHash === digest);
    if (!record || record.capabilityExpiresAt <= this.now() || !this.valid(record) ||
      (record.creator.kind === 'browser' ? record.creator.sessionKey !== issuerSessionKey :
        record.creator.actor !== actor || record.creator.issuerSessionKey !== issuerSessionKey))
      throw new Error('Host-session capability is unavailable');
    if (this.byActor.has(actor)) this.revokeActor(actor);
    record.capabilityHash = null; // one use, including later requests by this actor
    record.actor = actor;
    record.grantExpiresAt = grantExpiresAt;
    record.issuerSessionKey = issuerSessionKey;
    this.byActor.set(actor, record.terminalId);
    record.unsubscribe = this.onIssuerRevoked(issuerSessionKey, () => this.revokeActor(actor));
    if (!this.records.has(record.terminalId)) throw new Error('Host-session issuer expired');
    return { scopeId: this.scopeId(record.terminalId), expiresAt: grantExpiresAt };
  }

  scopeFor(actor: string): DevelopmentScope[] {
    const terminalId = this.byActor.get(actor);
    if (!terminalId) return [];
    const record = this.records.get(terminalId);
    if (!record || !this.valid(record)) {
      this.revokeActor(actor);
      return [];
    }
    return [{ id: this.scopeId(terminalId), root: record.root }];
  }

  revokeTerminal(terminalId: string): void {
    const record = this.records.get(terminalId);
    if (!record) return;
    this.records.delete(terminalId);
    record.unsubscribe?.();
    if (record.actor) {
      this.byActor.delete(record.actor);
      this.onRevoked(record.actor, this.scopeId(terminalId));
    }
  }

  revokeActor(actor: string): void {
    const terminalId = this.byActor.get(actor);
    if (terminalId) this.revokeTerminal(terminalId);
  }

  revokeAll(): void {
    for (const id of [...this.records.keys()]) this.revokeTerminal(id);
  }

  audit(): void {
    for (const [id, record] of this.records) {
      if (record.actor ? !this.valid(record) :
        record.capabilityExpiresAt <= this.now() || (record.terminal && !this.valid(record)))
        this.revokeTerminal(id);
    }
  }
}
