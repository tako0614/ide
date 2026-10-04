import type { BorrowedDesktopLease, BorrowedDesktopSnapshot } from './borrowed-desktop.js';
import { trustedDesktopFramebuffer, type DesktopFramebuffer, type DesktopStatus } from './desktop.js';
import { descriptorValidationBoundary, rejectDescriptorValidation } from './descriptor-validation.js';

export type ChatgptControllerOwner = {
  start(): Promise<{ lease: BorrowedDesktopLease; snapshot: BorrowedDesktopSnapshot }>;
  close(): Promise<void>;
};

export type ChatgptControllerDesktop = {
  attachBorrowedDesktop(lease: BorrowedDesktopLease, producerStateDir: string,
    framebuffer: DesktopFramebuffer): Promise<DesktopStatus>;
  detachBorrowedDesktop(lease: BorrowedDesktopLease): Promise<void>;
  status(): Promise<DesktopStatus>;
};

const UNAVAILABLE = 'ChatGPT desktop generation is unavailable';
type Detail = { role?: string; pid?: unknown; field?: string; expected?: unknown; observed?: unknown };
function unavailable(predicate: string, details?: Detail): never {
  return rejectDescriptorValidation(predicate, details, undefined, UNAVAILABLE);
}
function boundary(predicate: string, error: unknown): Error {
  return descriptorValidationBoundary(predicate, error, UNAVAILABLE);
}

/** One explicit owner generation. Constructing this class never starts an app. */
export class ChatgptController {
  private attempted = false;
  private closed = false;
  private preparing: Promise<DesktopStatus> | null = null;
  private closing: Promise<DesktopStatus> | null = null;
  private teardown: Promise<void> | null = null;
  private lease: BorrowedDesktopLease | null = null;
  private readonly framebuffer: DesktopFramebuffer;

  constructor(private readonly owner: ChatgptControllerOwner,
    private readonly desktop: ChatgptControllerDesktop,
    private readonly producerStateDir: string, framebuffer: DesktopFramebuffer) {
    try { this.framebuffer = trustedDesktopFramebuffer(framebuffer); }
    catch (error) { throw boundary('controller.framebuffer', error); }
  }

  prepare(): Promise<DesktopStatus> {
    if (this.closed || this.closing) return Promise.reject(boundary('controller.prepare.closed', new Error('closed')));
    if (this.preparing) return this.preparing;
    if (this.attempted) return Promise.reject(boundary('controller.prepare.attempted', new Error('already attempted')));
    this.attempted = true;
    const pending = this.prepareOwned();
    this.preparing = pending;
    void pending.then(() => { if (this.preparing === pending) this.preparing = null; },
      () => { if (this.preparing === pending) this.preparing = null; });
    return pending;
  }

  private async prepareOwned(): Promise<DesktopStatus> {
    try {
      let owned: Awaited<ReturnType<ChatgptControllerOwner['start']>>;
      try { owned = await this.owner.start(); }
      catch (error) { throw boundary('controller.prepare.owner_start', error); }
      let checked: BorrowedDesktopSnapshot;
      try { checked = owned.lease.check(); }
      catch (error) { throw boundary('controller.prepare.lease_check', error); }
      if (owned.snapshot.lifecycleMode !== 'deckide-owned') unavailable('controller.prepare.snapshot_lifecycle_mode', { field: 'lifecycle_mode', expected: 'deckide-owned', observed: owned.snapshot.lifecycleMode });
      if (checked.lifecycleMode !== 'deckide-owned') unavailable('controller.prepare.lease_lifecycle_mode', { field: 'lifecycle_mode', expected: 'deckide-owned', observed: checked.lifecycleMode });
      if (!/^[a-f0-9]{32}$/.test(checked.sessionId ?? '')) unavailable('controller.prepare.session_id', { field: 'session_id', expected: true, observed: false });
      if (checked.sessionId !== owned.snapshot.sessionId) unavailable('controller.prepare.session_id_match', { field: 'session_id', expected: true, observed: false });
      if (this.closed) unavailable('controller.prepare.closed_during_start', { field: 'closed', expected: false, observed: true });
      this.lease = owned.lease;
      let status: DesktopStatus;
      try { status = await this.desktop.attachBorrowedDesktop(owned.lease, this.producerStateDir,
        this.framebuffer); }
      catch (error) { throw boundary('controller.prepare.attach', error); }
      if (this.closed) unavailable('controller.prepare.closed_during_attach', { field: 'closed', expected: false, observed: true });
      if (status.running !== true) unavailable('controller.prepare.running', { field: 'running', expected: true, observed: false });
      if (status.transport !== 'private-rfb') unavailable('controller.prepare.transport', { field: 'transport', expected: true, observed: false });
      let confirmed: BorrowedDesktopSnapshot;
      try { confirmed = owned.lease.check(); }
      catch (error) { throw boundary('controller.prepare.confirmed_lease_check', error); }
      if (confirmed.lifecycleMode !== 'deckide-owned') unavailable('controller.prepare.confirmed_lifecycle_mode', { field: 'lifecycle_mode', expected: 'deckide-owned', observed: confirmed.lifecycleMode });
      if (confirmed.sessionId !== checked.sessionId) unavailable('controller.prepare.confirmed_session_id', { field: 'session_id', expected: true, observed: false });
      return status;
    } catch (error) {
      const primary = boundary('controller.prepare_owned', error);
      // If close started, it owns teardown after this prepare promise settles.
      if (!this.closed) {
        try { await this.beginTeardown(); }
        catch (cleanupError) { boundary('controller.prepare_cleanup', cleanupError); }
      }
      throw primary;
    }
  }

  private beginTeardown(): Promise<void> {
    if (this.teardown) return this.teardown;
    const teardown = (async () => {
      if (this.lease) {
        try { await this.desktop.detachBorrowedDesktop(this.lease); }
        catch (error) { throw boundary('controller.teardown.detach', error); }
      }
      try { await this.owner.close(); }
      catch (error) { throw boundary('controller.teardown.owner_close', error); }
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
      if (this.preparing) await this.preparing.catch((error) => {
        boundary('controller.close.wait_prepare', error);
      });
      await this.beginTeardown();
      try { return await this.desktop.status(); }
      catch (error) { throw boundary('controller.close.status', error); }
    } catch (error) { throw boundary('controller.close_owned', error); }
  }

  async shutdown(): Promise<void> { await this.close(); }
}
