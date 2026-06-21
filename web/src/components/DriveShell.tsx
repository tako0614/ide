import { useCallback, useEffect, useMemo, useState } from 'react';
import clsx from 'clsx';
import type { Workspace } from '../types';
import { listWorkspaces } from '../api';
import { useTheme } from '../hooks/useTheme';
import { DriveBrowser } from './DriveBrowser';
import { CodeServerTab } from './CodeServerTab';
import { BrowserPane } from './BrowserPane';
import { StatusMessage } from './StatusMessage';

interface DriveShellProps {
  wsBase: string;
}

// Google-Drive-style shell: a workspace rail + tabbed surfaces (Drive file
// browser, code-server editors, agent browser). All open surfaces stay mounted
// (inactive => hidden) so code-server and the agent browser keep their sessions
// alive across tab switches.
export function DriveShell({ wsBase }: DriveShellProps) {
  const { theme, handleToggleTheme } = useTheme();
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [selectedWsId, setSelectedWsId] = useState<string | null>(null);
  const [codeTabs, setCodeTabs] = useState<string[]>([]);
  const [browserOpen, setBrowserOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<string>('drive');
  const [status, setStatus] = useState('');

  useEffect(() => {
    let alive = true;
    listWorkspaces()
      .then((list) => {
        if (!alive) return;
        setWorkspaces(list);
        setSelectedWsId((prev) => prev ?? list[0]?.id ?? null);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const selectedWs = useMemo(
    () => workspaces.find((w) => w.id === selectedWsId) ?? null,
    [workspaces, selectedWsId]
  );
  const wsById = useMemo(() => new Map(workspaces.map((w) => [w.id, w])), [workspaces]);

  const openInEditor = useCallback(() => {
    if (!selectedWsId) return;
    setCodeTabs((prev) => (prev.includes(selectedWsId) ? prev : [...prev, selectedWsId]));
    setActiveTab(`code:${selectedWsId}`);
  }, [selectedWsId]);

  const closeCodeTab = useCallback((wsId: string) => {
    setCodeTabs((prev) => prev.filter((id) => id !== wsId));
    setActiveTab((cur) => (cur === `code:${wsId}` ? 'drive' : cur));
    // Best-effort: ask the server to stop the idle instance promptly.
    void fetch(`/codeserver/stop?wsId=${encodeURIComponent(wsId)}`, { method: 'POST', credentials: 'include' }).catch(() => undefined);
  }, []);

  const selectWorkspace = useCallback((wsId: string) => {
    setSelectedWsId(wsId);
    setActiveTab('drive');
  }, []);

  const tabs = useMemo(() => {
    const list: { id: string; label: string; closeable: boolean }[] = [
      { id: 'drive', label: selectedWs ? selectedWs.name : 'Drive', closeable: false },
    ];
    for (const wsId of codeTabs) {
      list.push({ id: `code:${wsId}`, label: `</> ${wsById.get(wsId)?.name ?? wsId}`, closeable: true });
    }
    if (browserOpen) {
      list.push({ id: 'browser', label: '◷ Browser', closeable: true });
    }
    return list;
  }, [selectedWs, codeTabs, browserOpen, wsById]);

  return (
    <div className="drive-shell flex h-full min-h-0" data-theme={theme}>
      <aside className="drive-rail flex flex-col w-[220px] flex-shrink-0 border-r border-border bg-sidebar min-h-0">
        <div className="px-3 py-2.5 text-[13px] font-semibold text-ink border-b border-border">Deck Drive</div>
        <div className="flex-1 min-h-0 overflow-auto py-2">
          <div className="px-3 py-1 text-[11px] uppercase tracking-wide text-muted">Workspaces</div>
          {workspaces.map((ws) => (
            <button
              key={ws.id}
              type="button"
              className={clsx(
                'w-full text-left px-3 py-1.5 text-[13px] truncate hover:bg-list-hover',
                ws.id === selectedWsId ? 'text-ink bg-list-hover font-medium' : 'text-ink-muted'
              )}
              onClick={() => selectWorkspace(ws.id)}
              title={ws.path}
            >
              📁 {ws.name}
            </button>
          ))}
          {workspaces.length === 0 && (
            <div className="px-3 py-2 text-[12px] text-muted">ワークスペースがありません</div>
          )}

          <div className="px-3 py-1 mt-3 text-[11px] uppercase tracking-wide text-muted">Open Items</div>
          {codeTabs.map((wsId) => (
            <div key={wsId} className="flex items-center px-3 py-1 text-[12px] text-ink-muted">
              <button type="button" className="flex-1 text-left truncate hover:text-ink" onClick={() => setActiveTab(`code:${wsId}`)}>
                {'</>'} {wsById.get(wsId)?.name ?? wsId}
              </button>
              <button type="button" className="drive-mini-btn" title="停止" onClick={() => closeCodeTab(wsId)}>×</button>
            </div>
          ))}
          <button
            type="button"
            className={clsx('w-full text-left px-3 py-1 text-[12px] hover:text-ink', browserOpen ? 'text-ink' : 'text-ink-muted')}
            onClick={() => { setBrowserOpen(true); setActiveTab('browser'); }}
          >
            ◷ Agent Browser
          </button>
        </div>
        <div className="border-t border-border px-3 py-2 flex items-center gap-2">
          <button type="button" className="topbar-btn-sm" title="テーマ切替" onClick={handleToggleTheme}>◐</button>
        </div>
      </aside>

      <main className="flex flex-col flex-1 min-h-0">
        <div className="drive-tabstrip flex items-center gap-1 px-2 border-b border-border bg-sidebar overflow-x-auto flex-shrink-0 min-h-[36px]">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              className={clsx('drive-tab flex items-center gap-1 px-3 py-1.5 text-[13px] whitespace-nowrap', activeTab === tab.id ? 'text-ink border-b-2 border-accent' : 'text-ink-muted')}
              onClick={() => setActiveTab(tab.id)}
            >
              <span className="truncate max-w-[160px]">{tab.label}</span>
              {tab.closeable && (
                <span
                  role="button"
                  aria-label="閉じる"
                  className="ml-1 text-muted hover:text-ink"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (tab.id.startsWith('code:')) closeCodeTab(tab.id.slice('code:'.length));
                    else if (tab.id === 'browser') { setBrowserOpen(false); setActiveTab('drive'); }
                  }}
                >
                  ×
                </span>
              )}
            </button>
          ))}
        </div>

        <div className="flex-1 min-h-0 relative">
          {/* Drive tab */}
          <div className="absolute inset-0" style={{ display: activeTab === 'drive' ? 'block' : 'none' }}>
            {selectedWs ? (
              <DriveBrowser
                key={selectedWs.id}
                workspaceId={selectedWs.id}
                workspacePath={selectedWs.path}
                onOpenInEditor={openInEditor}
                onStatus={setStatus}
              />
            ) : (
              <div className="flex items-center justify-center h-full text-muted text-[13px]">左でワークスペースを選択してください</div>
            )}
          </div>

          {/* code-server tabs — kept mounted to preserve the editor session */}
          {codeTabs.map((wsId) => {
            const ws = wsById.get(wsId);
            if (!ws) return null;
            return (
              <div key={wsId} className="absolute inset-0" style={{ display: activeTab === `code:${wsId}` ? 'block' : 'none' }}>
                <CodeServerTab wsId={wsId} folderPath={ws.path} />
              </div>
            );
          })}

          {/* Agent browser — mounted once opened to preserve the WebRTC/CDP session */}
          {browserOpen && (
            <div className="absolute inset-0" style={{ display: activeTab === 'browser' ? 'block' : 'none' }}>
              <BrowserPane wsBase={wsBase} />
            </div>
          )}
        </div>
      </main>

      <StatusMessage message={status} />
    </div>
  );
}
