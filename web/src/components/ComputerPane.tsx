import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import clsx from 'clsx';
import type RFB from '@novnc/novnc';
import { apiJson, getWsBase, getWsToken } from '../api';
import { XK, chordEvents, isKeyboardText, keysymForChar, type DesktopModifier } from './desktopKeys';
import './computer.css';

interface DesktopStatus {
  enabled: boolean;
  supported: boolean;
  running: boolean;
  owned?: boolean;
  display?: string;
  width?: number | null;
  height?: number | null;
  message?: string;
}

interface DesktopApp {
  id: string;
  name: string;
  comment?: string;
}

interface ComputerPaneProps {
  onClose: () => void;
  /** Fill the main area (hide the terminals) instead of sitting beside them. */
  expanded: boolean;
  onToggleExpanded: () => void;
}

type Connection = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'failed';

type KeyItem =
  | { label: string; title: string; keysym: number; ctrl?: boolean }
  | { label: string; title: string; modifier: DesktopModifier };

// Keys a phone keyboard lacks, plus a few shortcuts GUI apps rely on.
const KEY_ITEMS: KeyItem[] = [
  { label: 'Esc', title: 'Escape', keysym: XK.Escape },
  { label: 'Tab', title: 'Tab', keysym: XK.Tab },
  { label: 'Ctrl', title: 'Ctrl（次のキーに適用）', modifier: 'ctrl' },
  { label: 'Alt', title: 'Alt（次のキーに適用）', modifier: 'alt' },
  { label: 'Shift', title: 'Shift（次のキーに適用）', modifier: 'shift' },
  { label: '❖', title: 'Super（次のキーに適用）', modifier: 'super' },
  { label: '←', title: '左', keysym: XK.Left },
  { label: '↑', title: '上', keysym: XK.Up },
  { label: '↓', title: '下', keysym: XK.Down },
  { label: '→', title: '右', keysym: XK.Right },
  { label: '⌫', title: 'Backspace', keysym: XK.BackSpace },
  { label: '⏎', title: 'Enter', keysym: XK.Return },
  { label: '^C', title: 'Ctrl+C', keysym: 0x63, ctrl: true },
  { label: '^V', title: 'Ctrl+V', keysym: 0x76, ctrl: true },
  { label: '^A', title: 'Ctrl+A', keysym: 0x61, ctrl: true },
  { label: 'PgUp', title: 'Page Up', keysym: XK.PageUp },
  { label: 'PgDn', title: 'Page Down', keysym: XK.PageDown },
];

const RECONNECT_MS = 2000;
const MAX_CLIPBOARD_CHARS = 32_000;

let noVncModule: Promise<typeof import('@novnc/novnc')> | null = null;
// Loaded on first use: noVNC is only needed once the desktop is opened.
function loadNoVnc() {
  noVncModule ??= import('@novnc/novnc');
  return noVncModule;
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function ComputerPane({ onClose, expanded, onToggleExpanded }: ComputerPaneProps) {
  const [status, setStatus] = useState<DesktopStatus | null>(null);
  const [connection, setConnection] = useState<Connection>('idle');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [fit, setFit] = useState(true);
  const [apps, setApps] = useState<DesktopApp[] | null>(null);
  const [appsOpen, setAppsOpen] = useState(false);
  const [command, setCommand] = useState('');
  const [text, setText] = useState('');
  const [latched, setLatched] = useState<DesktopModifier[]>([]);
  const [remoteClipboard, setRemoteClipboard] = useState('');
  const screenRef = useRef<HTMLDivElement>(null);
  const imeRef = useRef<HTMLTextAreaElement>(null);
  const rfbRef = useRef<RFB | null>(null);
  const latchedRef = useRef<DesktopModifier[]>([]);
  const fitRef = useRef(fit);
  const disposedRef = useRef(false);
  const reconnectTimerRef = useRef<number | null>(null);
  latchedRef.current = latched;
  fitRef.current = fit;

  const refreshStatus = useCallback(async () => {
    try {
      const next = await apiJson<DesktopStatus>('/api/desktop');
      if (!disposedRef.current) setStatus(next);
      return next;
    } catch (statusError) {
      if (!disposedRef.current) setError(errorText(statusError, '状態を取得できませんでした。'));
      return null;
    }
  }, []);

  const applyViewMode = useCallback((rfb: RFB) => {
    const coarse = window.matchMedia('(pointer: coarse)').matches;
    rfb.scaleViewport = fitRef.current;
    rfb.clipViewport = !fitRef.current;
    // 1:1 on a touch screen: dragging pans the view instead of dragging in apps.
    rfb.dragViewport = !fitRef.current && coarse;
  }, []);

  const disconnect = useCallback(() => {
    if (reconnectTimerRef.current !== null) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    const rfb = rfbRef.current;
    rfbRef.current = null;
    rfb?.disconnect();
  }, []);

  const connect = useCallback(async () => {
    if (disposedRef.current || rfbRef.current || !screenRef.current) return;
    setConnection((current) => (current === 'connected' || current === 'reconnecting' ? 'reconnecting' : 'connecting'));
    try {
      const [{ password }, { token, authEnabled }, { default: RFBClass }] = await Promise.all([
        apiJson<{ password: string }>('/api/desktop/vnc', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
        }),
        getWsToken(),
        loadNoVnc(),
      ]);
      if (disposedRef.current || rfbRef.current || !screenRef.current) return;
      const url = `${getWsBase()}/api/desktop/vnc${authEnabled ? `?token=${encodeURIComponent(token)}` : ''}`;
      const rfb = new RFBClass(screenRef.current, url, { shared: true, credentials: { password } });
      rfb.resizeSession = false;
      rfb.showDotCursor = true;
      rfb.focusOnClick = true;
      rfb.qualityLevel = 6;
      rfb.compressionLevel = 2;
      rfb.background = '#101010';
      applyViewMode(rfb);
      rfb.addEventListener('connect', () => {
        if (rfbRef.current !== rfb) return;
        setConnection('connected');
        setError('');
      });
      rfb.addEventListener('credentialsrequired', () => rfb.sendCredentials({ password }));
      rfb.addEventListener('securityfailure', () => setError('デスクトップへの接続を認証できませんでした。'));
      rfb.addEventListener('clipboard', (event) => {
        const detail = (event as CustomEvent<{ text: string }>).detail;
        if (detail?.text) setRemoteClipboard(detail.text);
      });
      rfb.addEventListener('disconnect', () => {
        if (rfbRef.current !== rfb) return;
        rfbRef.current = null;
        if (disposedRef.current) return;
        setConnection('reconnecting');
        reconnectTimerRef.current = window.setTimeout(() => {
          reconnectTimerRef.current = null;
          void refreshStatus().then((next) => {
            if (next?.running) void connect();
            else setConnection('idle');
          });
        }, RECONNECT_MS);
      });
      rfbRef.current = rfb;
    } catch (connectError) {
      if (disposedRef.current) return;
      setConnection('failed');
      setError(errorText(connectError, 'デスクトップに接続できませんでした。'));
    }
  }, [applyViewMode, refreshStatus]);

  useEffect(() => {
    disposedRef.current = false;
    void refreshStatus();
    return () => {
      disposedRef.current = true;
      disconnect();
    };
  }, [disconnect, refreshStatus]);

  // Connect once the desktop is running and its screen element is mounted.
  useEffect(() => {
    if (status?.running && connection === 'idle') void connect();
  }, [status?.running, connection, connect]);

  useEffect(() => {
    if (rfbRef.current) applyViewMode(rfbRef.current);
  }, [fit, applyViewMode]);

  const post = useCallback(async <T,>(path: string, body: unknown = {}): Promise<T | null> => {
    setBusy(true);
    setError('');
    try {
      return await apiJson<T>(path, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
    } catch (postError) {
      setError(errorText(postError, '操作に失敗しました。'));
      return null;
    } finally {
      setBusy(false);
    }
  }, []);

  const startDesktop = async () => {
    const next = await post<DesktopStatus>('/api/desktop/start');
    if (!next) return;
    setConnection('idle');
    setStatus(next);
  };

  const stopDesktop = async () => {
    if (status?.owned && !window.confirm('デスクトップを停止しますか？\n開いている GUI アプリもすべて終了します。')) return;
    disconnect();
    const next = await post<DesktopStatus>('/api/desktop/stop');
    if (next) setStatus(next);
    setConnection('idle');
  };

  const toggleApps = async () => {
    const opening = !appsOpen;
    setAppsOpen(opening);
    if (opening && apps === null) {
      try {
        setApps(await apiJson<DesktopApp[]>('/api/desktop/apps'));
      } catch (appsError) {
        setError(errorText(appsError, 'アプリ一覧を取得できませんでした。'));
      }
    }
  };

  const launch = async (body: { appId?: string; command?: string }, label: string) => {
    const result = await post<{ name: string }>('/api/desktop/launch', body);
    if (result) {
      setNotice(`${result.name || label} を起動しました。`);
      window.setTimeout(() => setNotice(''), 3000);
    }
    return Boolean(result);
  };

  // ── Keyboard ──────────────────────────────────────────────────────

  /** Send one key with the latched modifiers (released afterwards). */
  const sendKey = useCallback((keysym: number, extra: DesktopModifier[] = []) => {
    const rfb = rfbRef.current;
    if (!rfb) return;
    const modifiers = Array.from(new Set([...latchedRef.current, ...extra]));
    for (const event of chordEvents({ modifiers, keysym })) rfb.sendKey(event.keysym, null, event.down);
    if (latchedRef.current.length) setLatched([]);
  }, []);

  /** ASCII goes as key presses; anything else (Japanese, emoji) is typed server-side. */
  const sendText = useCallback(async (value: string) => {
    if (!value) return;
    if (isKeyboardText(value) && rfbRef.current) {
      for (const char of value) {
        const keysym = keysymForChar(char);
        if (keysym !== null) sendKey(keysym);
      }
      return;
    }
    try {
      await apiJson('/api/desktop/type', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: value }),
      });
    } catch (typeError) {
      setError(errorText(typeError, '文字を送れませんでした。'));
    }
  }, [sendKey]);

  // Soft keyboard: a hidden textarea receives the phone keyboard's input.
  // Key presses go to the desktop as they happen; IME compositions (Japanese)
  // are sent once confirmed.
  useEffect(() => {
    const ime = imeRef.current;
    if (!ime) return;
    const reset = () => { ime.value = ''; };
    const onBeforeInput = (event: InputEvent) => {
      if (event.isComposing) return;
      switch (event.inputType) {
        case 'insertText':
        case 'insertReplacementText':
        case 'insertFromPaste':
          event.preventDefault();
          if (event.data) void sendText(event.data);
          break;
        case 'insertLineBreak':
        case 'insertParagraph':
          event.preventDefault();
          sendKey(XK.Return);
          break;
        case 'deleteContentBackward':
          event.preventDefault();
          sendKey(XK.BackSpace);
          break;
        case 'deleteContentForward':
          event.preventDefault();
          sendKey(XK.Delete);
          break;
        default:
          break;
      }
    };
    const onCompositionEnd = (event: CompositionEvent) => {
      reset();
      if (event.data) void sendText(event.data);
    };
    const KEYS: Record<string, number> = {
      Escape: XK.Escape, Tab: XK.Tab, ArrowLeft: XK.Left, ArrowRight: XK.Right, ArrowUp: XK.Up,
      ArrowDown: XK.Down, Home: XK.Home, End: XK.End, PageUp: XK.PageUp, PageDown: XK.PageDown,
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      const keysym = KEYS[event.key];
      if (keysym === undefined) return;
      event.preventDefault();
      sendKey(keysym);
    };
    ime.addEventListener('beforeinput', onBeforeInput);
    ime.addEventListener('compositionend', onCompositionEnd);
    ime.addEventListener('keydown', onKeyDown);
    return () => {
      ime.removeEventListener('beforeinput', onBeforeInput);
      ime.removeEventListener('compositionend', onCompositionEnd);
      ime.removeEventListener('keydown', onKeyDown);
    };
  }, [sendKey, sendText]);

  const toggleSoftKeyboard = () => {
    const ime = imeRef.current;
    if (!ime) return;
    if (document.activeElement === ime) ime.blur();
    else ime.focus({ preventScroll: true });
  };

  const pressItem = (item: KeyItem) => {
    if ('modifier' in item) {
      setLatched((current) => (current.includes(item.modifier)
        ? current.filter((modifier) => modifier !== item.modifier)
        : [...current, item.modifier]));
      return;
    }
    sendKey(item.keysym, item.ctrl ? ['ctrl'] : []);
  };

  const pasteToDesktop = async () => {
    let value: string | null = null;
    try {
      if (navigator.clipboard?.readText) value = await navigator.clipboard.readText();
    } catch {
      // Not a secure context or permission denied.
    }
    if (value === null) value = window.prompt('デスクトップのクリップボードに送るテキスト');
    if (!value) return;
    rfbRef.current?.clipboardPasteFrom(value.slice(0, MAX_CLIPBOARD_CHARS));
    setNotice('デスクトップのクリップボードに送りました（アプリで Ctrl+V）。');
    window.setTimeout(() => setNotice(''), 3000);
  };

  const copyRemoteClipboard = async () => {
    try {
      await navigator.clipboard.writeText(remoteClipboard);
      setNotice('コピーしました。');
      window.setTimeout(() => setNotice(''), 2000);
    } catch {
      window.prompt('コピーしてください', remoteClipboard);
    }
  };

  const submitCommand = async (event: FormEvent) => {
    event.preventDefault();
    const value = command.trim();
    if (value && await launch({ command: value }, value)) setCommand('');
  };

  const submitText = async (event: FormEvent) => {
    event.preventDefault();
    if (!text) return;
    await sendText(text);
    setText('');
  };

  // ── Render ────────────────────────────────────────────────────────

  const header = (
    <header className="computer-pane-header">
      <div className="computer-pane-heading">
        <h2>デスクトップ</h2>
        {status && (
          <span
            className={clsx('computer-status-dot', status.running ? 'running' : status.supported ? 'stopped' : 'unsupported')}
            title={status.running ? '起動中' : '停止中'}
          />
        )}
        {status?.running && (
          <span className="desktop-meta">
            {status.display} · {status.width}×{status.height}
            {connection !== 'connected' && connection !== 'idle' && ' · 接続中…'}
          </span>
        )}
      </div>
      <div className="computer-pane-header-actions">
        <button type="button" className="computer-icon-button" onClick={onToggleExpanded}
          title={expanded ? '端末と並べて表示' : '大きく表示'} aria-label={expanded ? '端末と並べて表示' : '大きく表示'}>
          {expanded ? '⊟' : '⛶'}
        </button>
        <button type="button" className="computer-icon-button" onClick={onClose} aria-label="デスクトップを閉じる" title="閉じる（デスクトップは動き続けます）">×</button>
      </div>
    </header>
  );

  if (status && (!status.enabled || !status.supported)) {
    return (
      <aside className={clsx('computer-pane', expanded && 'is-expanded')} aria-label="デスクトップ">
        {header}
        <div className="computer-empty-state">
          <span className="computer-status-dot unsupported" aria-hidden="true" />
          <h3>この環境では利用できません</h3>
          <p>{!status.enabled ? '共有デスクトップは無効です（DECKIDE_DESKTOP=false）。' : status.message}</p>
        </div>
      </aside>
    );
  }

  return (
    <aside className={clsx('computer-pane', expanded && 'is-expanded')} aria-label="デスクトップ">
      {header}
      {error && <p className="computer-feedback error" role="alert">{error}</p>}
      {notice && <p className="computer-feedback" role="status">{notice}</p>}
      {!status && !error && <p className="computer-loading" role="status">状態を確認しています…</p>}

      {status && !status.running && (
        <div className="computer-empty-state">
          <span className="computer-status-dot stopped" aria-hidden="true" />
          <h3>デスクトップは停止中です</h3>
          <p>エージェント用ブラウザや GUI アプリ（Grok Bot・ChatGPT など）が同じ画面で動く共有デスクトップを起動します。</p>
          <button type="button" className="computer-primary-button" onClick={() => void startDesktop()} disabled={busy}>
            {busy ? '起動しています…' : 'デスクトップを起動'}
          </button>
        </div>
      )}

      {status?.running && (
        <>
          <div className="desktop-toolbar">
            <div className="desktop-apps">
              <button type="button" className={clsx('computer-small-button', appsOpen && 'active')} onClick={() => void toggleApps()} aria-expanded={appsOpen}>
                アプリ ▾
              </button>
              {appsOpen && (
                <div className="desktop-apps-menu" role="menu">
                  {apps === null && <span className="desktop-apps-empty">読み込み中…</span>}
                  {apps?.length === 0 && <span className="desktop-apps-empty">アプリが見つかりません</span>}
                  {apps?.map((app) => (
                    <button key={app.id} type="button" role="menuitem" className="desktop-apps-item" title={app.comment || app.name}
                      onClick={() => { setAppsOpen(false); void launch({ appId: app.id }, app.name); }}>
                      {app.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <form className="desktop-command" onSubmit={(event) => void submitCommand(event)}>
              <input type="text" value={command} onChange={(event) => setCommand(event.target.value)}
                placeholder="コマンドを実行（例: grok-bot --no-sandbox）" aria-label="デスクトップで実行するコマンド"
                autoCapitalize="off" autoCorrect="off" spellCheck={false} />
              <button type="submit" className="computer-small-button" disabled={!command.trim() || busy}>実行</button>
            </form>
            <button type="button" className="computer-small-button" onClick={() => setFit((value) => !value)}
              title={fit ? '等倍で表示（はみ出した部分はスクロール）' : '全体を画面に合わせる'}>
              {fit ? '等倍' : '全体'}
            </button>
            <button type="button" className="computer-small-button" onClick={() => void pasteToDesktop()} title="手元のクリップボードをデスクトップへ送る">貼付</button>
            <button type="button" className="computer-small-button desktop-stop" onClick={() => void stopDesktop()} disabled={busy}
              title={status.owned ? 'デスクトップを停止' : '接続を切る（外部のデスクトップは止めません）'}>
              停止
            </button>
          </div>

          <div className="desktop-screen-wrap">
            <div ref={screenRef} className="desktop-screen" />
            {connection !== 'connected' && (
              <div className={clsx('desktop-screen-overlay', connection === 'failed' && 'is-failed')} role="status">
                {connection === 'failed' ? (
                  <button type="button" className="computer-small-button" onClick={() => { setError(''); setConnection('idle'); }}>
                    再接続
                  </button>
                ) : connection === 'reconnecting' ? '再接続しています…' : '接続しています…'}
              </div>
            )}
          </div>

          <div className="desktop-keys" role="toolbar" aria-label="特殊キー">
            <button type="button" className="desktop-key" tabIndex={-1} title="キーボードを表示/非表示"
              onPointerDown={(event) => event.preventDefault()} onClick={toggleSoftKeyboard}>⌨</button>
            {KEY_ITEMS.map((item) => {
              const active = 'modifier' in item && latched.includes(item.modifier);
              return (
                <button key={item.label} type="button" tabIndex={-1}
                  className={clsx('desktop-key', active && 'is-latched')} title={item.title} aria-label={item.title}
                  aria-pressed={'modifier' in item ? active : undefined}
                  onPointerDown={(event) => event.preventDefault()} onMouseDown={(event) => event.preventDefault()}
                  onClick={() => pressItem(item)} disabled={connection !== 'connected'}>
                  {item.label}
                </button>
              );
            })}
          </div>

          <form className="desktop-type" onSubmit={(event) => void submitText(event)}>
            <input type="text" value={text} onChange={(event) => setText(event.target.value)}
              placeholder="文字を送る（日本語も可）" aria-label="デスクトップへ送る文字" />
            <button type="submit" className="computer-small-button" disabled={!text}>送信</button>
          </form>

          {remoteClipboard && (
            <div className="desktop-clipboard">
              <span title={remoteClipboard}>📋 {remoteClipboard.slice(0, 80)}</span>
              <button type="button" className="computer-small-button" onClick={() => void copyRemoteClipboard()}>コピー</button>
              <button type="button" className="computer-icon-button" onClick={() => setRemoteClipboard('')} aria-label="閉じる">×</button>
            </div>
          )}
        </>
      )}
      <textarea ref={imeRef} className="desktop-ime" aria-hidden="true" tabIndex={-1}
        autoCapitalize="off" autoCorrect="off" autoComplete="off" spellCheck={false} />
    </aside>
  );
}
