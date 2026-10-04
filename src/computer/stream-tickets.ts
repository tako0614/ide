import { createHash } from 'node:crypto';
import { generateWsToken } from '../middleware/auth.js';

/** Extra route/epoch binding around the existing one-use signed-session ticket.
 * This adds no grant and accepts no caller root, display, or socket path. */
export class ComputerStreamTickets {
  private tickets = new Map<string, { session: string; epoch: number; expires: number }>();
  private digest(token: string): string { return createHash('sha256').update(token).digest('hex'); }
  private cleanup() {
    for (const [key, value] of this.tickets) if (value.expires <= Date.now()) this.tickets.delete(key);
  }
  issue(session: string, epoch: number): string {
    this.cleanup();
    if (!Number.isSafeInteger(epoch) || epoch < 0) throw new Error('Invalid desktop epoch');
    while (this.tickets.size >= 64) this.tickets.delete(this.tickets.keys().next().value!);
    const token = generateWsToken(session);
    this.tickets.set(this.digest(token), { session, epoch, expires: Date.now() + 30_000 });
    return token;
  }
  reserved(token: string): boolean { this.cleanup(); return this.tickets.has(this.digest(token)); }
  consume(token: string, session: string, epoch: number): boolean {
    this.cleanup();
    const key = this.digest(token);
    const ticket = this.tickets.get(key);
    this.tickets.delete(key);
    return !!ticket && ticket.session === session && ticket.epoch === epoch && ticket.expires > Date.now();
  }
}
