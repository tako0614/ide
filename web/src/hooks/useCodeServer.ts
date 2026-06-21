import { useEffect, useState } from 'react';
import type { CodeServerStatus } from '../types';

// Polls code-server capability/status for a workspace. Returns null until the
// first response. Used to show the "not installed" hint vs. the editor iframe.
export function useCodeServer(wsId: string | null): CodeServerStatus | null {
  const [status, setStatus] = useState<CodeServerStatus | null>(null);

  useEffect(() => {
    if (!wsId) {
      setStatus(null);
      return;
    }
    let alive = true;
    fetch(`/codeserver/status?wsId=${encodeURIComponent(wsId)}`, { credentials: 'include' })
      .then((r) => (r.ok ? (r.json() as Promise<CodeServerStatus>) : null))
      .then((s) => {
        if (alive && s) setStatus(s);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [wsId]);

  return status;
}
