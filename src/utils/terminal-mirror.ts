import headlessPkg from '@xterm/headless';
import serializePkg from '@xterm/addon-serialize';
import unicodePkg from '@xterm/addon-unicode11';
import type { TerminalMirrorHandle } from '../types.js';

const { Terminal } = headlessPkg;
const { SerializeAddon } = serializePkg;
const { Unicode11Addon } = unicodePkg;

// A socket with more than 1MB queued is dropped as a laggard (see
// broadcastToSockets), so a snapshot must leave room for live output behind
// it; past this size the scrollback is trimmed until it fits.
const MAX_SNAPSHOT_BYTES = 512 * 1024;

/**
 * A headless xterm that parses every byte the PTY emits, so a client that
 * (re)connects can be handed the *current screen* instead of a raw byte
 * replay. Raw replay renders history at whatever size the client has now,
 * which garbles anything drawn at an older size; the mirror reflows on resize
 * exactly like the clients do, so its snapshot always matches the PTY size.
 *
 * Resizes are queued behind the bytes already written, so output produced
 * before a resize is parsed at the old size — the same order clients see.
 */
export function createTerminalMirror(options: {
  cols: number;
  rows: number;
  scrollback: number;
  /** Absolute output offset of the next byte the PTY will emit. */
  currentOffset: () => number;
}): TerminalMirrorHandle | null {
  let term: InstanceType<typeof Terminal>;
  let serializer: InstanceType<typeof SerializeAddon>;
  try {
    term = new Terminal({
      cols: options.cols,
      rows: options.rows,
      scrollback: options.scrollback,
      allowProposedApi: true,
      // Arbitrary program output (e.g. `cat` of a binary) is full of parse
      // errors; logging each one floods the server log.
      logLevel: 'off',
    });
    serializer = new SerializeAddon();
    term.loadAddon(serializer);
  } catch (error) {
    console.warn('[TERMINAL] Mirror unavailable, falling back to raw replay:', error);
    return null;
  }
  try {
    // Clients render with Unicode 11 widths; the mirror must agree or wide
    // characters (CJK, emoji) land in different cells in the snapshot.
    term.loadAddon(new Unicode11Addon() as unknown as Parameters<typeof term.loadAddon>[0]);
    term.unicode.activeVersion = '11';
  } catch {
    // Unicode 6 widths are still usable; only wide-glyph alignment suffers.
  }

  let title: string | null = null;
  term.onTitleChange((next) => { title = next || null; });
  let disposed = false;

  return {
    write(data) {
      if (disposed) return;
      try {
        term.write(data);
      } catch (error) {
        // xterm refuses writes once its backlog passes 50MB. Losing the
        // mirror only costs snapshot fidelity; throwing here would reach the
        // PTY data handler and take the server down.
        console.warn('[TERMINAL] Mirror overloaded; snapshots disabled for this terminal:', error);
        disposed = true;
        try { term.dispose(); } catch { /* already broken */ }
      }
    },
    resize(cols, rows) {
      if (disposed) return;
      term.write('', () => {
        if (!disposed) term.resize(cols, rows);
      });
    },
    snapshot() {
      return new Promise((resolve, reject) => {
        if (disposed) {
          reject(new Error('Terminal mirror disposed'));
          return;
        }
        const offset = options.currentOffset();
        // The write callback runs once everything queued before it has been
        // parsed and before anything queued after it, so serializing inside
        // it captures exactly the output up to `offset`.
        term.write('', () => {
          if (disposed) {
            reject(new Error('Terminal mirror disposed'));
            return;
          }
          let scrollback = options.scrollback;
          let data = serializer.serialize({ scrollback });
          while (scrollback > 0 && Buffer.byteLength(data, 'utf8') > MAX_SNAPSHOT_BYTES) {
            scrollback = Math.floor(scrollback / 2);
            data = serializer.serialize({ scrollback });
          }
          resolve({ data, cols: term.cols, rows: term.rows, offset });
        });
      });
    },
    title: () => title,
    dispose() {
      if (disposed) return;
      disposed = true;
      term.dispose();
    },
  };
}
