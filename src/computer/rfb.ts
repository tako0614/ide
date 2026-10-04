/** Bounded client-to-server RFB 3.x gate and upstream handshake observer. */
export class RfbServerProtocolError extends Error {
  constructor(readonly phase: 'version' | 'security' | 'challenge' | 'result' | 'server_init',
    readonly reason: 'unexpected' | 'unsupported' | 'incomplete' | 'mismatch') {
    super(`RFB server ${phase} ${reason}`);
  }
}

export class RfbClientGate {
  private pending = Buffer.alloc(0);
  private phase: 'version' | 'security' | 'response' | 'init' | 'messages' = 'version';
  private serverPhase: 'version' | 'security' | 'securityTypes' | 'security33' |
    'challenge' | 'result' | 'server_init' | 'serverHeader' | 'serverName' | 'messages' = 'version';
  private serverOffset = 0;
  private serverVersion = Buffer.alloc(12);
  private serverSecurityTypes = 0;
  private serverOffersPassword = false;
  private serverResult = 0;
  private serverDimensions = Buffer.alloc(4);
  private serverNameLength = 0;
  private readonly held = new Set<number>();
  private buttons = 0;
  private x = 0;
  private y = 0;

  constructor(private readonly width: number, private readonly height: number,
    private readonly input: (kind: 'key' | 'pointer', active: boolean) => boolean) {
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) ||
      width < 1 || height < 1 || width > 8192 || height > 8192 || width * height > 16 * 1024 * 1024)
      throw new Error('Invalid RFB framebuffer geometry');
  }

  /** Inspect only handshake metadata. Never retain challenge bytes or later server messages. */
  observeServer(chunk: Buffer): Buffer[] {
    if (!Buffer.isBuffer(chunk)) throw new RfbServerProtocolError('version', 'unexpected');
    const forward: Buffer[] = [];
    let offset = 0;
    while (offset < chunk.length) {
      if (this.serverPhase === 'messages') {
        forward.push(chunk.subarray(offset));
        break;
      }
      if (this.serverPhase === 'version') {
        const size = Math.min(12 - this.serverOffset, chunk.length - offset);
        chunk.copy(this.serverVersion, this.serverOffset, offset, offset + size);
        forward.push(chunk.subarray(offset, offset + size));
        this.serverOffset += size; offset += size;
        if (this.serverOffset === 12) {
          const version = this.serverVersion.toString('ascii');
          if (version !== 'RFB 003.008\n' && version !== 'RFB 003.007\n' && version !== 'RFB 003.003\n')
            throw new RfbServerProtocolError('version', 'unsupported');
          this.serverPhase = version === 'RFB 003.003\n' ? 'security33' : 'security';
          this.serverOffset = 0;
        }
        continue;
      }
      if (this.serverPhase === 'security' || this.serverPhase === 'securityTypes' ||
        this.serverPhase === 'security33') {
        if (this.phase !== 'security' && this.phase !== 'response')
          throw new RfbServerProtocolError('security', 'unexpected');
        if (this.serverPhase === 'security') {
          this.serverSecurityTypes = chunk[offset];
          if (!this.serverSecurityTypes || this.serverSecurityTypes > 64)
            throw new RfbServerProtocolError('security', 'unsupported');
          forward.push(chunk.subarray(offset, ++offset));
          this.serverPhase = 'securityTypes';
          continue;
        }
        if (this.serverPhase === 'securityTypes') {
          const size = Math.min(this.serverSecurityTypes, chunk.length - offset);
          for (let i = 0; i < size; i++) this.serverOffersPassword ||= chunk[offset + i] === 2;
          forward.push(chunk.subarray(offset, offset + size));
          offset += size; this.serverSecurityTypes -= size;
          if (this.serverSecurityTypes === 0) {
            if (!this.serverOffersPassword) throw new RfbServerProtocolError('security', 'unsupported');
            this.serverPhase = 'challenge';
            this.serverOffset = 0;
          }
          continue;
        }
        const size = Math.min(4 - this.serverOffset, chunk.length - offset);
        for (let i = 0; i < size; i++) this.serverResult = (this.serverResult << 8) | chunk[offset + i];
        forward.push(chunk.subarray(offset, offset + size));
        offset += size; this.serverOffset += size;
        if (this.serverOffset === 4) {
          if (this.serverResult !== 2) throw new RfbServerProtocolError('security', 'unsupported');
          this.serverPhase = 'challenge'; this.serverOffset = 0; this.serverResult = 0;
        }
        continue;
      }
      if (this.serverPhase === 'challenge') {
        if (this.phase !== 'response') throw new RfbServerProtocolError('challenge', 'unexpected');
        const size = Math.min(16 - this.serverOffset, chunk.length - offset);
        forward.push(chunk.subarray(offset, offset + size));
        offset += size; this.serverOffset += size;
        if (this.serverOffset === 16) { this.serverPhase = 'result'; this.serverOffset = 0; }
        continue;
      }
      if (this.serverPhase === 'result') {
        if (this.phase !== 'init') throw new RfbServerProtocolError('result', 'unexpected');
        const size = Math.min(4 - this.serverOffset, chunk.length - offset);
        for (let i = 0; i < size; i++) this.serverResult = (this.serverResult << 8) | chunk[offset + i];
        forward.push(chunk.subarray(offset, offset + size));
        offset += size; this.serverOffset += size;
        if (this.serverOffset === 4) {
          if (this.serverResult !== 0) throw new RfbServerProtocolError('result', 'unsupported');
          this.serverPhase = 'server_init'; this.serverOffset = 0;
        }
        continue;
      }
      if (this.serverPhase === 'serverHeader') {
        const size = Math.min(20 - this.serverOffset, chunk.length - offset);
        for (let i = 0; i < size; i++) {
          if (this.serverOffset + i >= 16)
            this.serverNameLength = this.serverNameLength * 256 + chunk[offset + i];
        }
        forward.push(chunk.subarray(offset, offset + size));
        offset += size; this.serverOffset += size;
        if (this.serverOffset === 20) {
          if (this.serverNameLength > 65536)
            throw new RfbServerProtocolError('server_init', 'unsupported');
          this.serverPhase = this.serverNameLength ? 'serverName' : 'messages';
          this.serverOffset = 0;
        }
        continue;
      }
      if (this.serverPhase === 'serverName') {
        const size = Math.min(this.serverNameLength - this.serverOffset, chunk.length - offset);
        forward.push(chunk.subarray(offset, offset + size));
        offset += size; this.serverOffset += size;
        if (this.serverOffset === this.serverNameLength) this.serverPhase = 'messages';
        continue;
      }
      if (this.phase !== 'messages') throw new RfbServerProtocolError('server_init', 'unexpected');
      const size = Math.min(4 - this.serverOffset, chunk.length - offset);
      chunk.copy(this.serverDimensions, this.serverOffset, offset, offset + size);
      offset += size; this.serverOffset += size;
      if (this.serverOffset === 4) {
        if (this.serverDimensions.readUInt16BE(0) !== this.width ||
          this.serverDimensions.readUInt16BE(2) !== this.height)
          throw new RfbServerProtocolError('server_init', 'mismatch');
        forward.push(Buffer.from(this.serverDimensions));
        this.serverPhase = 'serverHeader'; this.serverOffset = 0;
      }
    }
    return forward;
  }

  assertServerComplete(): void {
    if (this.serverPhase !== 'messages')
      throw new RfbServerProtocolError(
        this.serverPhase === 'version' ? 'version' :
          ['security', 'securityTypes', 'security33'].includes(this.serverPhase) ? 'security' :
            this.serverPhase === 'challenge' ? 'challenge' :
              this.serverPhase === 'result' ? 'result' : 'server_init', 'incomplete');
  }

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
        if (this.serverPhase === 'version') throw new Error('RFB server version is incomplete');
        const version = this.pending.subarray(0, size).toString('ascii');
        if (version !== 'RFB 003.008\n' && version !== 'RFB 003.007\n' &&
          version !== 'RFB 003.003\n')
          throw new Error('Unsupported RFB version');
        if (Number(version.slice(8, 11)) > Number(this.serverVersion.toString('ascii').slice(8, 11)))
          throw new Error('RFB version mismatch');
        if (version === 'RFB 003.003\n') this.serverPhase = 'security33';
        this.phase = version === 'RFB 003.003\n' ? 'response' : 'security';
      } else if (this.phase === 'security') {
        size = 1;
        if (this.pending.length < size) break;
        if (this.serverPhase !== 'challenge') throw new Error('RFB security offer is incomplete');
        if (this.pending[0] !== 2) throw new Error('RFB password authentication required');
        this.phase = 'response';
      } else if (this.phase === 'response') {
        size = 16;
        if (this.pending.length < size) break;
        if (this.serverPhase !== 'result') throw new Error('RFB challenge is incomplete');
        this.phase = 'init';
      } else if (this.phase === 'init') {
        size = 1;
        if (this.pending.length < size) break;
        if (this.serverPhase !== 'server_init') throw new Error('RFB authentication result is incomplete');
        if (this.pending[0] > 1) throw new Error('Invalid RFB client init');
        this.phase = 'messages';
      } else {
        if (this.serverPhase !== 'messages') throw new Error('RFB server init is incomplete');
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
          this.pending = size === this.pending.length ? Buffer.alloc(0) : this.pending.subarray(size);
          continue;
        }
      }
      accepted.push(replacement ?? Buffer.from(this.pending.subarray(0, size)));
      this.pending = size === this.pending.length ? Buffer.alloc(0) : this.pending.subarray(size);
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
