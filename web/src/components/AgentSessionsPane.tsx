import { useEffect, useRef, useState } from 'react';
import { apiJson } from '../api';
import type { Deck } from '../types';
import './AgentSessionsPane.css';

type AgentTool = 'codex' | 'claude' | 'opencode';
type AgentStatus = 'running' | 'connected' | 'history' | 'unknown';
type AgentKind = 'desktop' | 'cli' | 'other';

export interface AgentTask {
  tool: AgentTool;
  sourceId: string;
  id: string;
  title: string;
  status: AgentStatus;
  kind: AgentKind;
  archived?: boolean;
  updatedAt: number;
  cwd: string;
  /** The live DeckIDE terminal running this session, if any. */
  terminal?: { id: string; deckId: string };
  /** Shell command that resumes the session in a terminal. */
  resumeCommand?: string;
}

interface AgentLibraryPage {
  tasks: AgentTask[];
  sources: Array<{ tool: AgentTool; id: string; label: string; available: boolean }>;
  nextOffset: number | null;
  liveStatusComplete: boolean;
}

interface AgentConversation {
  task: AgentTask;
  messages: Array<{ role: 'user' | 'assistant'; text: string }>;
  truncated?: boolean;
}

type StatusFilter = 'all' | 'live' | 'past';

const taskKey = (task: AgentTask) => `${task.tool}/${task.sourceId}/${task.id}`;
const TOOL_LABELS: Record<AgentTool, string> = { codex: 'Codex', claude: 'Claude Code', opencode: 'OpenCode' };
const STATUS_LABELS: Record<AgentStatus, string> = { running: '実行中', connected: '接続中', history: '過去', unknown: '確認不可' };
const KIND_LABELS: Record<AgentKind, string> = { desktop: 'Desktop', cli: 'CLI', other: 'App / その他' };
const formatTime = (value: number) => Number.isFinite(value)
  ? new Date(value).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  : '';

interface AgentSessionsPaneProps {
  decks: Deck[];
  activeDeckId?: string;
  /** Show the live terminal that runs a session. */
  onTerminal: (terminal: { id: string; deckId: string }) => void;
  /** Resume a past session in a new terminal of the given deck. */
  onResume: (task: AgentTask, deckId: string) => Promise<void>;
  onClose: () => void;
}

/** Codex / Claude Code / OpenCode sessions on this machine: list, read, open or resume in a terminal. */
export function AgentSessionsPane({ decks, activeDeckId, onTerminal, onResume, onClose }: AgentSessionsPaneProps) {
  const [library, setLibrary] = useState<AgentLibraryPage | null>(null);
  const [tool, setTool] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [selected, setSelected] = useState<AgentTask | null>(null);
  const [conversation, setConversation] = useState<AgentConversation | null>(null);
  const [listError, setListError] = useState('');
  const [conversationError, setConversationError] = useState('');
  const [loadingMore, setLoadingMore] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [resumeDeckId, setResumeDeckId] = useState(activeDeckId || decks[0]?.id || '');
  const [refreshKey, setRefreshKey] = useState(0);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const queryRef = useRef(search);
  queryRef.current = search + '/' + tool;

  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(searchInput.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  useEffect(() => {
    if (!decks.some((deck) => deck.id === resumeDeckId)) setResumeDeckId(activeDeckId || decks[0]?.id || '');
  }, [decks, activeDeckId, resumeDeckId]);

  // The list refreshes every 5 seconds so running/connected states stay current.
  useEffect(() => {
    const controller = new AbortController();
    let timer: number | undefined;
    let first = true;
    setListError('');
    setLibrary(null);
    async function load() {
      try {
        const page = await apiJson<AgentLibraryPage>(`/api/agents?limit=100&search=${encodeURIComponent(search)}&tool=${encodeURIComponent(tool)}`, { signal: controller.signal });
        if (controller.signal.aborted) return;
        setLibrary((previous) => {
          const fresh = new Set(page.tasks.map(taskKey));
          return first || !previous
            ? page
            : { ...page, tasks: [...page.tasks, ...previous.tasks.filter((task) => !fresh.has(taskKey(task)))], nextOffset: previous.nextOffset };
        });
        first = false;
        setListError('');
        const current = selectedRef.current;
        const updated = current && page.tasks.find((task) => taskKey(task) === taskKey(current));
        if (updated) setSelected(updated);
      } catch (error) {
        if (!controller.signal.aborted) setListError(error instanceof Error ? error.message : '一覧を読み取れません。');
      }
      if (!controller.signal.aborted) timer = window.setTimeout(() => void load(), 5000);
    }
    void load();
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [search, tool, refreshKey]);

  const selectedKey = selected ? taskKey(selected) : '';
  const selectedStatus = selected?.status;
  // A live session's conversation is polled every 3 seconds.
  useEffect(() => {
    if (!selectedKey) {
      setConversation(null);
      return;
    }
    const controller = new AbortController();
    let timer: number | undefined;
    setConversation(null);
    setConversationError('');
    async function load() {
      try {
        const value = await apiJson<AgentConversation>(`/api/agents/${selectedKey}`, { signal: controller.signal });
        if (!controller.signal.aborted) {
          setConversation(value);
          setConversationError('');
        }
      } catch (error) {
        if (!controller.signal.aborted) setConversationError(error instanceof Error ? error.message : '会話を読み取れません。');
      }
      if (!controller.signal.aborted && (selectedStatus === 'running' || selectedStatus === 'connected')) {
        timer = window.setTimeout(() => void load(), 3000);
      }
    }
    void load();
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [selectedKey, selectedStatus, refreshKey]);

  const visibleTasks = library?.tasks.filter((task) => statusFilter === 'all' ||
    (statusFilter === 'live' ? ['running', 'connected'].includes(task.status) : task.status === 'history')) || [];
  const shown = conversation?.task || selected;

  const loadMore = async () => {
    if (library?.nextOffset == null || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await apiJson<AgentLibraryPage>(`/api/agents?limit=100&offset=${library.nextOffset}&search=${encodeURIComponent(search)}&tool=${encodeURIComponent(tool)}`);
      if (queryRef.current !== search + '/' + tool) return;
      setLibrary((previous) => previous
        ? { ...page, tasks: [...previous.tasks, ...page.tasks.filter((task) => !previous.tasks.some((known) => taskKey(known) === taskKey(task)))] }
        : page);
    } catch (error) {
      if (queryRef.current === search + '/' + tool) setListError(error instanceof Error ? error.message : '一覧を読み取れません。');
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <section className="codex-pane" aria-label="AIセッションと会話">
      <aside className="codex-task-sidebar">
        <div className="codex-library-heading">
          <h2>AIセッション</h2>
          <button type="button" onClick={() => setRefreshKey((value) => value + 1)} aria-label="一覧を再読込">↻</button>
          <button type="button" onClick={onClose} aria-label="ターミナルに戻る">×</button>
        </div>
        <label className="codex-search">
          <span className="sr-only">タイトルを検索</span>
          <input value={searchInput} onChange={(event) => setSearchInput(event.target.value)} placeholder="タイトルを検索" />
        </label>
        <label className="codex-provider">
          <span className="sr-only">AIツール</span>
          <select value={tool} onChange={(event) => {
            setSelected(null);
            setTool(event.target.value);
          }}>
            <option value="">すべてのツール</option>
            <option value="codex">Codex</option>
            <option value="claude">Claude Code</option>
            <option value="opencode">OpenCode</option>
          </select>
        </label>
        <div className="codex-filters" role="group" aria-label="タスクの状態">
          {([['all', 'すべて'], ['live', '実行中'], ['past', '過去']] as const).map(([value, label]) => (
            <button key={value} type="button" aria-pressed={statusFilter === value} onClick={() => setStatusFilter(value)}>{label}</button>
          ))}
        </div>
        {listError && <p className="codex-notice" role="alert">{listError}</p>}
        {library?.sources.filter((source) => !source.available).map((source) => (
          <p key={`${source.tool}/${source.id}`} className="codex-notice">{source.label}を読み取れません。</p>
        ))}
        {library && !library.liveStatusComplete && <p className="codex-notice">一部の実行状態を確認できません。</p>}
        <div className="codex-task-list">
          {!library && !listError && <p className="codex-empty" role="status">読み込み中…</p>}
          {library && visibleTasks.length === 0 && <p className="codex-empty">該当するタスクはありません。</p>}
          {visibleTasks.map((task) => (
            <button
              key={taskKey(task)}
              type="button"
              className={`codex-task-row ${selectedKey === taskKey(task) ? 'selected' : ''}`}
              onClick={() => setSelected(task)}
              aria-pressed={selectedKey === taskKey(task)}
            >
              <span className="codex-task-title">{task.title}</span>
              <span className="codex-task-meta">
                <span className={`codex-state codex-state-${task.status}`}>{STATUS_LABELS[task.status]}</span>
                <span>{TOOL_LABELS[task.tool]}</span>
                <span>{KIND_LABELS[task.kind]}</span>
                {task.archived && <span>アーカイブ</span>}
                <time>{formatTime(task.updatedAt)}</time>
              </span>
              <span className="codex-task-path" title={task.cwd}>{task.cwd}</span>
            </button>
          ))}
          {library?.nextOffset != null && (
            <button type="button" className="codex-more" disabled={loadingMore} onClick={() => void loadMore()}>
              {loadingMore ? '読み込み中…' : 'さらに表示'}
            </button>
          )}
        </div>
      </aside>
      <div className="codex-conversation">
        {shown ? (
          <>
            <header className="codex-conversation-heading">
              <div>
                <h2>{shown.title}</h2>
                <p>{TOOL_LABELS[shown.tool]} · {KIND_LABELS[shown.kind]} · {STATUS_LABELS[shown.status]} · {shown.cwd}</p>
              </div>
              {shown.terminal ? (
                <button type="button" className="topbar-btn-sm" onClick={() => onTerminal(shown.terminal!)}>実行中の端末を開く</button>
              ) : shown.resumeCommand && (
                <div className="codex-resume">
                  <label>
                    <span className="sr-only">再開するデッキ</span>
                    <select value={resumeDeckId} onChange={(event) => setResumeDeckId(event.target.value)}>
                      {decks.map((deck) => <option key={deck.id} value={deck.id}>{deck.name}</option>)}
                    </select>
                  </label>
                  <button type="button" className="topbar-btn-sm" disabled={!resumeDeckId || resuming} onClick={async () => {
                    setResuming(true);
                    setConversationError('');
                    try {
                      await onResume(shown, resumeDeckId);
                    } catch (error) {
                      setConversationError(error instanceof Error ? error.message : '再開できません。');
                    } finally {
                      setResuming(false);
                    }
                  }}>
                    {resuming ? '起動中…' : shown.tool === 'opencode' ? '同じサーバーへ接続' : 'CLIで再開'}
                  </button>
                </div>
              )}
            </header>
            <div className="codex-messages" role="log" aria-label="選択したセッションの会話">
              {conversationError && <p className="codex-notice" role="alert">{conversationError}</p>}
              {!conversation && !conversationError && <p className="codex-empty" role="status">会話を読み込み中…</p>}
              {conversation?.truncated && <p className="codex-notice">直近の会話を表示しています。全履歴は元のツールで確認できます。</p>}
              {conversation?.messages.map((message, index) => (
                <article key={index} className={`codex-message codex-message-${message.role}`}>
                  <div className="codex-message-author">{message.role === 'user' ? 'あなた' : TOOL_LABELS[shown.tool]}</div>
                  <pre>{message.text}</pre>
                </article>
              ))}
              {conversation && !conversation.messages.length && <p className="codex-empty">表示できる会話はまだありません。</p>}
            </div>
          </>
        ) : (
          <div className="codex-welcome">
            <span>Codex · Claude Code · OpenCode</span>
            <h2>タスクと会話</h2>
            <p>Desktop・CLI・サーバーのセッションを選ぶと、ここに会話が表示されます。</p>
          </div>
        )}
      </div>
    </section>
  );
}
