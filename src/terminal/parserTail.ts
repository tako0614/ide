/** Bytes consumed by the emulator but not represented in a serialized screen yet. */
export class ParserTail {
  private mode: 'normal' | 'escape' | 'csi' | 'string' | 'stringEscape' = 'normal';
  private utf8 = 0;
  private osc = false;
  private bytes: number[] = [];
  private overflow = false;

  push(data: Uint8Array): void {
    for (const byte of data) {
      if (this.mode === 'normal') {
        if (this.utf8) {
          if ((byte & 0xc0) === 0x80) {
            this.bytes.push(byte);
            if (!--this.utf8) this.bytes = [];
            continue;
          }
          this.utf8 = 0;
          this.bytes = [];
        }
        if (byte === 0x1b) {
          this.mode = 'escape';
          this.bytes = [byte];
        } else if (byte >= 0xc2 && byte <= 0xf4) {
          this.utf8 = byte < 0xe0 ? 1 : byte < 0xf0 ? 2 : 3;
          this.bytes = [byte];
        }
        continue;
      }

      if (byte === 0x18 || byte === 0x1a) {
        this.complete();
        continue;
      }
      // C0 controls within ESC/CSI have already affected the canonical cursor.
      if ((this.mode === 'escape' || this.mode === 'csi') && byte < 0x20 && byte !== 0x1b) continue;
      if (this.bytes.length < 65536) this.bytes.push(byte); else this.overflow = true;
      if (byte === 0x18 || byte === 0x1a) {
        this.complete();
        continue;
      }
      if (this.mode === 'escape') {
        if (byte === 0x5b) this.mode = 'csi';
        else if ([0x5d, 0x50, 0x58, 0x5e, 0x5f].includes(byte)) {
          this.mode = 'string';
          this.osc = byte === 0x5d;
        } else if (byte === 0x1b) this.bytes = [byte];
        else if (byte >= 0x30 && byte <= 0x7e) this.complete();
      } else if (this.mode === 'csi') {
        if (byte >= 0x40 && byte <= 0x7e) this.complete();
        else if (byte === 0x1b) {
          this.mode = 'escape';
          this.bytes = [byte];
          this.overflow = false;
        }
      } else if (this.mode === 'string') {
        if (byte === 0x07 && this.osc) this.complete();
        else if (byte === 0x1b) this.mode = 'stringEscape';
      } else if (this.mode === 'stringEscape') {
        if (byte === 0x5c) this.complete();
        else this.mode = byte === 0x1b ? 'stringEscape' : 'string';
      }
    }
  }

  private complete(): void {
    this.mode = 'normal';
    this.bytes = [];
    this.overflow = false;
  }

  snapshot(): string {
    if (this.overflow) throw new Error('Incomplete terminal control sequence exceeds snapshot limit');
    return Buffer.from(this.bytes).toString('base64');
  }
}
