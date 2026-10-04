/** Own one retry timer per terminal; the socket remains owned by TerminalTile. */
export function createTerminalReconnect(connect: () => void) {
  let attempts = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const cancel = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };

  return {
    schedule() {
      if (disposed || timer !== null) return;
      const delay = Math.min(30_000, 1000 * 2 ** attempts);
      attempts = Math.min(attempts + 1, 5);
      timer = setTimeout(() => {
        timer = null;
        if (!disposed) connect();
      }, delay);
    },
    reset() {
      attempts = 0;
    },
    cancel,
    dispose() {
      disposed = true;
      cancel();
    },
  };
}
