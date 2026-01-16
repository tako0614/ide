import { useCallback, useEffect, useMemo, useState } from 'react';
import { DeckList } from './components/DeckList';
import { EditorPane } from './components/EditorPane';
import { FileTree } from './components/FileTree';
import { SideNav } from './components/SideNav';
import { TerminalPane } from './components/TerminalPane';
import { WorkspaceList } from './components/WorkspaceList';
import {
  createDeck as apiCreateDeck,
  createTerminal as apiCreateTerminal,
  createWorkspace as apiCreateWorkspace,
  getWsBase,
  listDecks,
  listFiles,
  listWorkspaces,
  readFile,
  writeFile
} from './api';
import type {
  Deck,
  DeckState,
  EditorFile,
  FileSystemEntry,
  FileTreeNode,
  Workspace,
  WorkspaceState
} from './types';

type AppView = 'workspace' | 'terminal';

const DEFAULT_ROOT = import.meta.env.VITE_DEFAULT_ROOT || 'C:/workspace';
const SAVED_MESSAGE = '\u4fdd\u5b58\u3057\u307e\u3057\u305f\u3002';

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  js: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  json: 'json',
  md: 'markdown',
  css: 'css',
  html: 'html',
  yml: 'yaml',
  yaml: 'yaml',
  sh: 'shell',
  ps1: 'powershell',
  py: 'python',
  go: 'go',
  rs: 'rust'
};

const createEmptyWorkspaceState = (): WorkspaceState => ({
  files: [],
  activeFileId: null,
  tree: [],
  treeLoading: false,
  treeError: null
});

const createEmptyDeckState = (): DeckState => ({
  terminals: [],
  activeTerminalId: null
});

const toTreeNodes = (entries: FileSystemEntry[]): FileTreeNode[] =>
  entries.map((entry) => ({
    ...entry,
    expanded: false,
    loading: false,
    children: entry.type === 'dir' ? [] : undefined
  }));

const getLanguageFromPath = (filePath: string): string => {
  const extension = filePath.split('.').pop()?.toLowerCase();
  return LANGUAGE_BY_EXTENSION[extension] || 'plaintext';
};

const getErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const normalizeWorkspacePath = (value: string): string =>
  value
    .trim()
    .replace(/[\\/]+$/, '')
    .replace(/\\/g, '/')
    .toLowerCase();

export default function App() {
  const [view, setView] = useState<AppView>('terminal');
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(null);
  const [workspaceStates, setWorkspaceStates] = useState<
    Record<string, WorkspaceState>
  >({});
  const [decks, setDecks] = useState<Deck[]>([]);
  const [activeDeckId, setActiveDeckId] = useState<string | null>(null);
  const [deckStates, setDeckStates] = useState<Record<string, DeckState>>({});
  const [statusMessage, setStatusMessage] = useState('');
  const [savingFileId, setSavingFileId] = useState<string | null>(null);

  const defaultWorkspaceState = useMemo(
    () => createEmptyWorkspaceState(),
    []
  );
  const defaultDeckState = useMemo(() => createEmptyDeckState(), []);
  const activeWorkspace =
    workspaces.find((workspace) => workspace.id === activeWorkspaceId) || null;
  const activeWorkspaceState = activeWorkspaceId
    ? workspaceStates[activeWorkspaceId] || defaultWorkspaceState
    : defaultWorkspaceState;
  const activeDeckState = activeDeckId
    ? deckStates[activeDeckId] || defaultDeckState
    : defaultDeckState;
  const wsBase = getWsBase();

  const decksForWorkspace = activeWorkspaceId
    ? decks.filter((deck) => deck.workspaceId === activeWorkspaceId)
    : [];
  const deckListItems = decksForWorkspace.map((deck) => ({
    id: deck.id,
    name: deck.name,
    path: deck.root
  }));

  const updateWorkspaceState = useCallback(
    (workspaceId: string, updater: (state: WorkspaceState) => WorkspaceState) => {
      setWorkspaceStates((prev) => {
        const current = prev[workspaceId] || createEmptyWorkspaceState();
        return { ...prev, [workspaceId]: updater(current) };
      });
    },
    []
  );

  const updateDeckState = useCallback(
    (deckId: string, updater: (state: DeckState) => DeckState) => {
      setDeckStates((prev) => {
        const current = prev[deckId] || createEmptyDeckState();
        return { ...prev, [deckId]: updater(current) };
      });
    },
    []
  );

  useEffect(() => {
    let alive = true;
    listWorkspaces()
      .then((data) => {
        if (!alive) return;
        setWorkspaces(data);
        setActiveWorkspaceId((prev) => prev ?? data[0]?.id ?? null);
        setWorkspaceStates((prev) => {
          const next = { ...prev };
          data.forEach((workspace) => {
            if (!next[workspace.id]) {
              next[workspace.id] = createEmptyWorkspaceState();
            }
          });
          return next;
        });
      })
      .catch((error: unknown) => {
        if (!alive) return;
        setStatusMessage(
          `\u30d7\u30ed\u30b8\u30a7\u30af\u30c8\u3092\u53d6\u5f97\u3067\u304d\u307e\u305b\u3093\u3067\u3057\u305f: ${getErrorMessage(error)}`
        );
      });

    listDecks()
      .then((data) => {
        if (!alive) return;
        setDecks(data);
        setDeckStates((prev) => {
          const next = { ...prev };
          data.forEach((deck) => {
            if (!next[deck.id]) {
              next[deck.id] = createEmptyDeckState();
            }
          });
          return next;
        });
      })
      .catch((error: unknown) => {
        if (!alive) return;
        setStatusMessage(
          `\u30c7\u30c3\u30ad\u3092\u53d6\u5f97\u3067\u304d\u307e\u305b\u3093\u3067\u3057\u305f: ${getErrorMessage(error)}`
        );
      });

    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (statusMessage !== SAVED_MESSAGE) return;
    const timer = setTimeout(() => setStatusMessage(''), 2000);
    return () => clearTimeout(timer);
  }, [statusMessage]);

  useEffect(() => {
    if (!activeWorkspaceId) {
      setActiveDeckId(null);
      return;
    }
    const workspaceDecks = decks.filter(
      (deck) => deck.workspaceId === activeWorkspaceId
    );
    if (workspaceDecks.length === 0) {
      setActiveDeckId(null);
      return;
    }
    if (!workspaceDecks.some((deck) => deck.id === activeDeckId)) {
      setActiveDeckId(workspaceDecks[0].id);
    }
  }, [activeWorkspaceId, decks, activeDeckId]);

  useEffect(() => {
    if (!activeWorkspaceId) return;
    const current = workspaceStates[activeWorkspaceId];
    if (current?.tree?.length || current?.treeLoading) return;
    updateWorkspaceState(activeWorkspaceId, (state) => ({
      ...state,
      treeLoading: true,
      treeError: null
    }));
    listFiles(activeWorkspaceId, '')
      .then((entries) => {
        updateWorkspaceState(activeWorkspaceId, (state) => ({
          ...state,
          tree: toTreeNodes(entries),
          treeLoading: false
        }));
      })
      .catch((error: unknown) => {
        updateWorkspaceState(activeWorkspaceId, (state) => ({
          ...state,
          treeLoading: false,
          treeError: getErrorMessage(error)
        }));
      });
  }, [activeWorkspaceId, updateWorkspaceState, workspaceStates]);

  const handleCreateWorkspace = async (path: string) => {
    const trimmedPath = path.trim() || DEFAULT_ROOT;
    const normalized = normalizeWorkspacePath(trimmedPath);
    const exists = workspaces.some(
      (workspace) => normalizeWorkspacePath(workspace.path) === normalized
    );
    if (exists) {
      setStatusMessage(
        '\u540c\u3058\u30d1\u30b9\u306e\u30d7\u30ed\u30b8\u30a7\u30af\u30c8\u306f\u8ffd\u52a0\u3067\u304d\u307e\u305b\u3093\u3002'
      );
      return;
    }
    try {
      const workspace = await apiCreateWorkspace(trimmedPath);
      setWorkspaces((prev) => [...prev, workspace]);
      setActiveWorkspaceId(workspace.id);
      setWorkspaceStates((prev) => ({
        ...prev,
        [workspace.id]: createEmptyWorkspaceState()
      }));
    } catch (error: unknown) {
      setStatusMessage(
        `\u30d7\u30ed\u30b8\u30a7\u30af\u30c8\u3092\u8ffd\u52a0\u3067\u304d\u307e\u305b\u3093\u3067\u3057\u305f: ${getErrorMessage(error)}`
      );
    }
  };

  const handleCreateDeck = async (workspaceId: string | null) => {
    if (!workspaceId) {
      setStatusMessage(
        '\u30d7\u30ed\u30b8\u30a7\u30af\u30c8\u3092\u9078\u629e\u3057\u3066\u304f\u3060\u3055\u3044\u3002'
      );
      return;
    }
    try {
      const deck = await apiCreateDeck(
        `\u30c7\u30c3\u30ad ${decks.length + 1}`,
        workspaceId
      );
      setDecks((prev) => [...prev, deck]);
      setActiveDeckId(deck.id);
      setDeckStates((prev) => ({
        ...prev,
        [deck.id]: createEmptyDeckState()
      }));
    } catch (error: unknown) {
      setStatusMessage(
        `\u30c7\u30c3\u30ad\u306e\u4f5c\u6210\u306b\u5931\u6557\u3057\u307e\u3057\u305f: ${getErrorMessage(error)}`
      );
    }
  };

  const handleRefreshTree = () => {
    if (!activeWorkspaceId) return;
    updateWorkspaceState(activeWorkspaceId, (state) => ({
      ...state,
      treeLoading: true,
      treeError: null
    }));
    listFiles(activeWorkspaceId, '')
      .then((entries) => {
        updateWorkspaceState(activeWorkspaceId, (state) => ({
          ...state,
          tree: toTreeNodes(entries),
          treeLoading: false
        }));
      })
      .catch((error: unknown) => {
        updateWorkspaceState(activeWorkspaceId, (state) => ({
          ...state,
          treeLoading: false,
          treeError: getErrorMessage(error)
        }));
      });
  };

  const updateTreeNode = (
    nodes: FileTreeNode[],
    targetPath: string,
    updater: (node: FileTreeNode) => FileTreeNode
  ): FileTreeNode[] =>
    nodes.map((node) => {
      if (node.path === targetPath) {
        return updater(node);
      }
      if (node.children) {
        return {
          ...node,
          children: updateTreeNode(node.children, targetPath, updater)
        };
      }
      return node;
    });

  const handleToggleDir = (node: FileTreeNode) => {
    if (!activeWorkspaceId || node.type !== 'dir') return;
    if (node.expanded) {
      updateWorkspaceState(activeWorkspaceId, (state) => ({
        ...state,
        tree: updateTreeNode(state.tree, node.path, (item) => ({
          ...item,
          expanded: false
        }))
      }));
      return;
    }
    if (node.children && node.children.length > 0) {
      updateWorkspaceState(activeWorkspaceId, (state) => ({
        ...state,
        tree: updateTreeNode(state.tree, node.path, (item) => ({
          ...item,
          expanded: true
        }))
      }));
      return;
    }

    updateWorkspaceState(activeWorkspaceId, (state) => ({
      ...state,
      tree: updateTreeNode(state.tree, node.path, (item) => ({
        ...item,
        loading: true
      }))
    }));
    listFiles(activeWorkspaceId, node.path)
      .then((entries) => {
        updateWorkspaceState(activeWorkspaceId, (state) => ({
          ...state,
          tree: updateTreeNode(state.tree, node.path, (item) => ({
            ...item,
            expanded: true,
            loading: false,
            children: toTreeNodes(entries)
          }))
        }));
      })
      .catch((error: unknown) => {
        updateWorkspaceState(activeWorkspaceId, (state) => ({
          ...state,
          treeError: getErrorMessage(error),
          tree: updateTreeNode(state.tree, node.path, (item) => ({
            ...item,
            loading: false
          }))
        }));
      });
  };

  const handleOpenFile = (entry: FileTreeNode) => {
    if (!activeWorkspaceId || entry.type !== 'file') return;
    const existing = activeWorkspaceState.files.find(
      (file) => file.path === entry.path
    );
    if (existing) {
      updateWorkspaceState(activeWorkspaceId, (state) => ({
        ...state,
        activeFileId: existing.id
      }));
      return;
    }
    readFile(activeWorkspaceId, entry.path)
      .then((data) => {
        const file: EditorFile = {
          id: crypto.randomUUID(),
          name: entry.name,
          path: entry.path,
          language: getLanguageFromPath(entry.path),
          contents: data.contents,
          dirty: false
        };
        updateWorkspaceState(activeWorkspaceId, (state) => ({
          ...state,
          files: [...state.files, file],
          activeFileId: file.id
        }));
      })
      .catch((error: unknown) => {
        setStatusMessage(
          `\u30d5\u30a1\u30a4\u30eb\u3092\u958b\u3051\u307e\u305b\u3093\u3067\u3057\u305f: ${getErrorMessage(error)}`
        );
      });
  };

  const handleFileChange = (fileId: string, contents: string) => {
    if (!activeWorkspaceId) return;
    updateWorkspaceState(activeWorkspaceId, (state) => ({
      ...state,
      files: state.files.map((file) =>
        file.id === fileId ? { ...file, contents, dirty: true } : file
      )
    }));
  };

  const handleSaveFile = async (fileId: string) => {
    if (!activeWorkspaceId) return;
    const file = activeWorkspaceState.files.find((item) => item.id === fileId);
    if (!file) return;
    setSavingFileId(fileId);
    try {
      await writeFile(activeWorkspaceId, file.path, file.contents);
      updateWorkspaceState(activeWorkspaceId, (state) => ({
        ...state,
        files: state.files.map((item) =>
          item.id === fileId ? { ...item, dirty: false } : item
        )
      }));
      setStatusMessage(SAVED_MESSAGE);
    } catch (error: unknown) {
      setStatusMessage(
        `\u4fdd\u5b58\u306b\u5931\u6557\u3057\u307e\u3057\u305f: ${getErrorMessage(error)}`
      );
    } finally {
      setSavingFileId(null);
    }
  };

  const handleCreateTerminal = async () => {
    if (!activeDeckId) {
      setStatusMessage(
        '\u30c7\u30c3\u30ad\u3092\u9078\u629e\u3057\u3066\u304f\u3060\u3055\u3044\u3002'
      );
      return;
    }
    try {
      const session = await apiCreateTerminal(activeDeckId);
      updateDeckState(activeDeckId, (state) => {
        const index = state.terminals.length + 1;
        const terminal = {
          id: session.id,
          title: `\u30bf\u30fc\u30df\u30ca\u30eb ${index}`
        };
        return {
          ...state,
          terminals: [...state.terminals, terminal],
          activeTerminalId: terminal.id
        };
      });
    } catch (error: unknown) {
      setStatusMessage(
        `\u30bf\u30fc\u30df\u30ca\u30eb\u3092\u8d77\u52d5\u3067\u304d\u307e\u305b\u3093\u3067\u3057\u305f: ${getErrorMessage(error)}`
      );
    }
  };

  const handleSelectTerminal = (terminalId: string) => {
    if (!activeDeckId) return;
    updateDeckState(activeDeckId, (state) => ({
      ...state,
      activeTerminalId: terminalId
    }));
  };

  const handleSelectDeck = (deckId: string) => {
    setActiveDeckId(deckId);
  };

  return (
    <div className="app" data-view={view}>
      <SideNav activeView={view} onSelect={setView} />
      <main className="main">
        {view === 'workspace' ? (
          <div className="workspace-view">
            <WorkspaceList
              workspaces={workspaces}
              activeWorkspaceId={activeWorkspaceId}
              defaultPath={DEFAULT_ROOT}
              onSelect={setActiveWorkspaceId}
              onCreate={handleCreateWorkspace}
            />
            <div className="workspace-editor">
              {!activeWorkspaceId ? (
                <div className="panel empty-panel">
                  {'\u30d7\u30ed\u30b8\u30a7\u30af\u30c8\u3092\u8ffd\u52a0\u3057\u3066\u304f\u3060\u3055\u3044\u3002'}
                </div>
              ) : (
                <>
                  <FileTree
                    root={activeWorkspace?.path || DEFAULT_ROOT}
                    entries={activeWorkspaceState.tree}
                    loading={activeWorkspaceState.treeLoading}
                    error={activeWorkspaceState.treeError}
                    onToggleDir={handleToggleDir}
                    onOpenFile={handleOpenFile}
                    onRefresh={handleRefreshTree}
                  />
                  <EditorPane
                    files={activeWorkspaceState.files}
                    activeFileId={activeWorkspaceState.activeFileId}
                    onSelectFile={(fileId) => {
                      if (!activeWorkspaceId) return;
                      updateWorkspaceState(activeWorkspaceId, (state) => ({
                        ...state,
                        activeFileId: fileId
                      }));
                    }}
                    onChangeFile={handleFileChange}
                    onSaveFile={handleSaveFile}
                    savingFileId={savingFileId}
                  />
                </>
              )}
            </div>
          </div>
        ) : (
          <div className="terminal-layout">
            <DeckList
              decks={deckListItems}
              activeDeckId={activeDeckId}
              onSelect={handleSelectDeck}
              onCreate={() => handleCreateDeck(activeWorkspaceId)}
            />
            {activeDeckId ? (
              <TerminalPane
                terminals={activeDeckState.terminals}
                activeTerminalId={activeDeckState.activeTerminalId}
                wsBase={wsBase}
                onSelectTerminal={handleSelectTerminal}
                onNewTerminal={handleCreateTerminal}
              />
            ) : (
              <div className="panel empty-panel">
                {'\u30c7\u30c3\u30ad\u3092\u4f5c\u6210\u3057\u3066\u304f\u3060\u3055\u3044\u3002'}
              </div>
            )}
          </div>
        )}
      </main>
      {statusMessage ? (
        <div className="status-float" role="status">
          {statusMessage}
        </div>
      ) : null}
    </div>
  );
}
