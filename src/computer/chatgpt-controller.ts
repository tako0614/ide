import type { BorrowedDesktopLease, BorrowedDesktopSnapshot } from './borrowed-desktop.js';
import type { DesktopStatus } from './desktop.js';

export type ChatgptControllerOwner = {
  start(): Promise<{ lease: BorrowedDesktopLease; snapshot: BorrowedDesktopSnapshot }>;
  close(): Promise<void>;
};

export type ChatgptControllerDesktop = {
  attachBorrowedDesktop(lease: BorrowedDesktopLease, producerStateDir: string): Promise<DesktopStatus>;
  detachBorrowedDesktop(lease: BorrowedDesktopLease): Promise<void>;
  status(): Promise<DesktopStatus>;
};

function unavailable(): never { throw new Error('ChatGPT desktop generation is unavailable'); }

/** One explicit owner generation. Constructing this class never starts an app. */
export class ChatgptController {
  private attempted = false;
  private closed = false;
  private preparing: Promise<DesktopStatus> | null = null;
  private closing: Promise<DesktopStatus> | null = null;
  private teardown: Promise<void> | null = null;
  private lease: BorrowedDesktopLease | null = null;

  constructor(private readonly owner: ChatgptControllerOwner,
    private readonly desktop: ChatgptControllerDesktop,
    private readonly producerStateDir: string) {}

  prepare(): Promise<DesktopStatus> {
    if (this.closed || this.closing) return Promise.reject(new Error('ChatGPT desktop generation is unavailable'));
    if (this.preparing) return this.preparing;
    if (this.attempted) return Promise.reject(new Error('ChatGPT desktop generation is unavailable'));
    this.attempted = true;
    const pending = this.prepareOwned();
    this.preparing = pending;
    void pending.then(() => { if (this.preparing === pending) this.preparing = null; },
      () => { if (this.preparing === pending) this.preparing = null; });
    return pending;
  }

  private async prepareOwned(): Promise<DesktopStatus> {
    try {
      const owned = await this.owner.start();
      const checked = owned.lease.check();
      if (owned.snapshot.lifecycleMode !== 'deckide-owned' ||
        checked.lifecycleMode !== 'deckide-owned' ||
        !/^[a-f0-9]{32}$/.test(checked.sessionId ?? '') ||
        checked.sessionId !== owned.snapshot.sessionId || this.closed) unavailable();
      this.lease = owned.lease;
      const status = await this.desktop.attachBorrowedDesktop(owned.lease, this.producerStateDir);
      if (this.closed || status.running !== true || status.transport !== 'private-rfb') unavailable();
      const confirmed = owned.lease.check();
      if (confirmed.lifecycleMode !== 'deckide-owned' || confirmed.sessionId !== checked.sessionId) unavailable();
      return status;
    } catch {
      // If close started, it owns teardown after this prepare promise settles.
      if (!this.closed) {
        try { await this.beginTeardown(); }
        catch { unavailable(); }
      }
      return unavailable();
    }
  }

  private beginTeardown(): Promise<void> {
    if (this.teardown) return this.teardown;
    const teardown = (async () => {
      if (this.lease) await this.desktop.detachBorrowedDesktop(this.lease);
      await this.owner.close();
    })();
    this.teardown = teardown;
    return teardown;
  }

  close(): Promise<DesktopStatus> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = this.closeOwned();
    return this.closing;
  }

  private async closeOwned(): Promise<DesktopStatus> {
    try {
      if (this.preparing) await this.preparing.catch(() => undefined);
      await this.beginTeardown();
      return await this.desktop.status();
    } catch { return unavailable(); }
  }

  async shutdown(): Promise<void> { await this.close(); }
}
