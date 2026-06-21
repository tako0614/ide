import { useMemo } from 'react';
import { useCodeServer } from '../hooks/useCodeServer';

interface CodeServerTabProps {
  wsId: string;
  folderPath: string;
}

// Embeds a workspace's code-server instance via the same-origin reverse proxy.
// The server spawns/streams the instance lazily on first request.
export function CodeServerTab({ wsId, folderPath }: CodeServerTabProps) {
  const status = useCodeServer(wsId);
  const src = useMemo(
    () => `/codeserver/${wsId}/?folder=${encodeURIComponent(folderPath)}`,
    [wsId, folderPath]
  );

  if (status && !status.acquired) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 text-center p-6 text-muted">
        <div className="text-[15px] font-semibold text-ink">{'VS Code (code-server) は未インストールです'}</div>
        <div className="text-[13px]">{'サーバで次を実行してください:'}</div>
        <code className="bg-list-hover px-2 py-1 rounded text-[13px]">deckide codeserver install</code>
      </div>
    );
  }

  return (
    <iframe
      className="code-server-frame"
      src={src}
      title="VS Code"
      style={{ width: '100%', height: '100%', border: 0, display: 'block', background: '#1e1e1e' }}
      allow="clipboard-read; clipboard-write"
    />
  );
}
