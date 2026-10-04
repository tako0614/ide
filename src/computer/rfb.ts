/** Bounded client-to-server RFB 3.x gate. Server bytes remain opaque. */
export class RfbClientGate {
  private pending = Buffer.alloc(0);
  private phase: 'version' | 'security' | 'response' | 'init' | 'messages' = 'version';
  private readonly held = new Set<number>();
  private buttons = 0;
  private x = 0;
  private y = 0;

  constructor(private readonly width: number, private readonly height: number,
    private readonly input: (kind: 'key' | 'pointer', active: boolean) => boolean) {}

  acceptClient(chunk: Buffer): Buffer[] {
    if (!Buffer.isBuffer(chunk) || chunk.length > 256 * 1024 ||
      this.pending.length + chunk.length > 256 * 1024) throw new Error('Invalid RFB client data');
    this.pending = Buffer.concat([this.pending, chunk]);
    const accepted: Buffer[] = [];
    while (this.pending.length) {
      let size = 0;
      let replacement: Buffer | null = null;
      if (this.phase === 'version') {
        size = 12;
        if (this.pending.length < size) break;
        const version = this.pending.subarray(0, size).toString('ascii');
        if (version !== 'RFB 003.008\n' && version !== 'RFB 003.007\n' &&
          version !== 'RFB 003.003\n')
          throw new Error('Unsupported RFB version');
        this.phase = version === 'RFB 003.003\n' ? 'response' : 'security';
      } else if (this.phase === 'security') {
        size = 1;
        if (this.pending.length < size) break;
        if (this.pending[0] !== 2) throw new Error('RFB password authentication required');
        this.phase = 'response';
      } else if (this.phase === 'response') {
        size = 16;
        if (this.pending.length < size) break;
        this.phase = 'init';
      } else if (this.phase === 'init') {
        size = 1;
        if (this.pending.length < size) break;
        if (this.pending[0] > 1) throw new Error('Invalid RFB client init');
        this.phase = 'messages';
      } else {
        const type = this.pending[0];
        let forward = true;
        if (type === 0) size = 20; // SetPixelFormat
        else if (type === 2) {
          if (this.pending.length < 4) break;
          const count = this.pending.readUInt16BE(2);
          if (count > 64) throw new Error('Too many RFB encodings');
          size = 4 + 4 * count;
        } else if (type === 3) size = 10; // FramebufferUpdateRequest
        else if (type === 4) size = 8; // KeyEvent
        else if (type === 5) size = 6; // PointerEvent
        else throw new Error('RFB client message is not permitted');
        if (this.pending.length < size) break;
        if (type === 2) {
          // noVNC advertises several extensions that would later send opaque
          // input message types. Strip them before x11vnc can enable them.
          const acceptedEncodings: number[] = [];
          for (let offset = 4; offset < size; offset += 4) {
            const encoding = this.pending.readInt32BE(offset);
            if ([0, 1, 2, 5, 6, 7, 16, -260, 21, 50, -223, -224, -239, 0x574d5664].includes(encoding) ||
              (encoding >= -32 && encoding <= -23) || (encoding >= -256 && encoding <= -247))
              acceptedEncodings.push(encoding);
          }
          if (!acceptedEncodings.includes(0)) acceptedEncodings.push(0);
          replacement = Buffer.alloc(4 + 4 * acceptedEncodings.length);
          replacement[0] = 2;
          replacement.writeUInt16BE(acceptedEncodings.length, 2);
          acceptedEncodings.forEach((encoding, index) => replacement!.writeInt32BE(encoding, 4 + 4 * index));
        } else if (type === 3) {
          const x = this.pending.readUInt16BE(2), y = this.pending.readUInt16BE(4);
          const w = this.pending.readUInt16BE(6), h = this.pending.readUInt16BE(8);
          if (!w || !h || x + w > this.width || y + h > this.height)
            throw new Error('RFB update exceeds private display');
        } else if (type === 4) {
          if (this.pending[1] > 1 || this.pending[2] || this.pending[3])
            throw new Error('Invalid RFB key event');
          const key = this.pending.readUInt32BE(4);
          if (this.pending[1] && this.held.size >= 32 && !this.held.has(key))
            throw new Error('Too many held keys');
          forward = this.input('key', this.pending[1] === 1);
          if (forward && this.pending[1]) {
            this.held.add(key);
          } else if (forward) this.held.delete(key);
        } else if (type === 5) {
          const mask = this.pending[1], x = this.pending.readUInt16BE(2), y = this.pending.readUInt16BE(4);
          if (mask & ~0x7f || x >= this.width || y >= this.height)
            throw new Error('Invalid RFB pointer event');
          forward = this.input('pointer', (mask & 0x7f) !== 0);
          if (forward) {
            this.buttons = mask & 0x7f;
            this.x = x; this.y = y;
          }
        }
        if (!forward) {
          this.pending = this.pending.subarray(size);
          continue;
        }
      }
      accepted.push(replacement ?? Buffer.from(this.pending.subarray(0, size)));
      this.pending = this.pending.subarray(size);
    }
    return accepted;
  }

  /** Release only input this connection pressed on its own display. */
  releaseMessages(): Buffer[] {
    const releases: Buffer[] = [];
    for (const key of this.held) {
      const event = Buffer.alloc(8);
      event[0] = 4;
      event.writeUInt32BE(key, 4);
      releases.push(event);
    }
    this.held.clear();
    if (this.buttons) {
      const event = Buffer.alloc(6);
      event[0] = 5;
      event.writeUInt16BE(this.x, 2);
      event.writeUInt16BE(this.y, 4);
      releases.push(event);
      this.buttons = 0;
    }
    return releases;
  }
}
