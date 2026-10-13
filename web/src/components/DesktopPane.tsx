import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import clsx from 'clsx';
import type RFB from '@novnc/novnc';
import { apiJson, getWsBase, getWsToken } from '../api';
import { XK, chordEvents, isKeyboardText, keysymForChar, type DesktopModifier } from './desktopKeys';
import './computer.css';
import './desktop.css';

interface DesktopStatus {
  installed: boolean;
  running: boolean;
  display: string;
  width: number | null;
  height: number | null;
  message?: string;
}

interface DesktopPaneProps {
  onClose: () => void;
}

type Connection = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'failed';

/** resize: the desktop takes this pane's size. fit: scale the whole desktop. actual: 1:1, scroll/pan. */
type ViewMode = 'resize' | 'fit' | 'actual';

const VIEW_MODES: Array<{ mode: ViewMode; label: string; title: string }> = [
  { mode: 'resize', label: '自動サイズ', title: 'デスクトップの解像度をこの画面の大きさに合わせる' },
  { mode: 'fit', label: '全体', title: '解像度はそのままで全体を縮小表示' },
  { mode: 'actual', label: '等倍', title: '等倍で表示（はみ出した部分はスクロール）' },
];
const VIEW_STORAGE_KEY = 'deckide-desktop-view';

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

function initialViewMode(): ViewMode {
  try {
    const saved = localStorage.getItem(VIEW_STORAGE_KEY);
    if (saved === 'resize' || saved === 'fit' || saved === 'actual') return saved;
  } catch {
    // Storage unavailable.
  }
  // A phone is too small to be the desktop's resolution: show it whole instead.
  return window.matchMedia('(pointer: coarse)').matches ? 'fit' : 'resize';
}

export function DesktopPane({ onClose }: DesktopPaneProps) {
  const [status, setStatus] = useState<DesktopStatus | null>(null);
  const [connection, setConnection] = useState<Connection>('idle');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const [view, setView] = useState<ViewMode>(initialViewMode);
  const [text, setText] = useState('');
  const [latched, setLatched] = useState<DesktopModifier[]>([]);
  const [remoteClipboard, setRemoteClipboard] = useState('');
  const screenRef = useRef<HTMLDivElement>(null);
  const imeRef = useRef<HTMLTextAreaElement>(null);
  const rfbRef = useRef<RFB | null>(null);
  const latchedRef = useRef<DesktopModifier[]>([]);
  const viewRef = useRef(view);
  const disposedRef = useRef(false);
  const reconnectTimerRef = useRef<number | null>(null);
  latchedRef.current = latched;
  viewRef.current = view;

  const flash = useCallback((message: string, ms = 3000) => {
    setNotice(message);
    window.setTimeout(() => setNotice((current) => (current === message ? '' : current)), ms);
  }, []);

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
    const mode = viewRef.current;
    const coarse = window.matchMedia('(pointer: coarse)').matches;
    rfb.resizeSession = mode === 'resize';
    rfb.scaleViewport = mode === 'fit';
    rfb.clipViewport = mode === 'actual';
    // 1:1 on a touch screen: dragging pans the view instead of dragging in apps.
    rfb.dragViewport = mode === 'actual' && coarse;
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
      const [{ token, authEnabled }, { default: RFBClass }] = await Promise.all([getWsToken(), loadNoVnc()]);
      if (disposedRef.current || rfbRef.current || !screenRef.current) return;
      const url = `${getWsBase()}/api/desktop/vnc${authEnabled ? `?token=${encodeURIComponent(token)}` : ''}`;
      const rfb = new RFBClass(screenRef.current, url, { shared: true });
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
    try { localStorage.setItem(VIEW_STORAGE_KEY, view); } catch { /* storage unavailable */ }
  }, [view, applyViewMode]);

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

  const restartDesktop = async () => {
    if (!window.confirm('デスクトップを再起動しますか？\n開いている GUI アプリはすべて終了します。')) return;
    disconnect();
    setConnection('reconnecting');
    const next = await post<DesktopStatus>('/api/desktop/restart');
    if (next) setStatus(next);
    setConnection('idle');
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
    flash('デスクトップのクリップボードに送りました（アプリで Ctrl+V）。');
  };

  const copyRemoteClipboard = async () => {
    try {
      await navigator.clipboard.writeText(remoteClipboard);
      flash('コピーしました。', 2000);
    } catch {
      window.prompt('コピーしてください', remoteClipboard);
    }
  };

  const submitText = async (event: FormEvent) => {
    event.preventDefault();
    if (!text) return;
    await sendText(text);
    setText('');
  };

  const cycleView = () => {
    const index = VIEW_MODES.findIndex((entry) => entry.mode === view);
    setView(VIEW_MODES[(index + 1) % VIEW_MODES.length].mode);
  };
  const viewEntry = VIEW_MODES.find((entry) => entry.mode === view) ?? VIEW_MODES[0];

  // ── Render ────────────────────────────────────────────────────────

  return (
    <aside className={clsx('computer-pane', 'desktop-pane', maximized && 'computer-pane-maximized')} aria-label="デスクトップ">
      <header className="computer-pane-header">
        <div className="desktop-heading">
          <h2>デスクトップ</h2>
          {status && (
            <span className={clsx('desktop-status-dot', status.running ? 'running' : 'stopped')}
              title={status.running ? '起動中' : '停止中'} />
          )}
          {status?.running && connection !== 'connected' && connection !== 'idle' && (
            <span className="desktop-meta">接続中…</span>
          )}
        </div>
        <div className="desktop-header-actions">
          <button type="button" className="desktop-icon-button" onClick={() => setMaximized((value) => !value)}
            title={maximized ? '元のサイズに戻す' : '全画面で表示'} aria-label={maximized ? '元のサイズに戻す' : '全画面で表示'}>
            {maximized ? '⊟' : '⛶'}
          </button>
          <button type="button" className="desktop-icon-button" onClick={onClose}
            aria-label="デスクトップを閉じる" title="閉じる（アプリは動き続けます）">×</button>
        </div>
      </header>

      {error && <p className="desktop-feedback error" role="alert">{error}</p>}
      {notice && <p className="desktop-feedback" role="status">{notice}</p>}
      {!status && !error && <p className="desktop-feedback" role="status">状態を確認しています…</p>}

      {status && !status.running && (
        <div className="desktop-empty-state">
          <h3>{status.installed ? 'デスクトップは停止中です' : 'デスクトップが未導入です'}</h3>
          <p>{status.message || 'XFCE のデスクトップを起動します。DeckIDE を再起動してもアプリは閉じません。'}</p>
          {status.installed && (
            <button type="button" className="desktop-primary-button" onClick={() => void startDesktop()} disabled={busy}>
              {busy ? '起動しています…' : 'デスクトップを起動'}
            </button>
          )}
        </div>
      )}

      {status?.running && (
        <>
          <div className="desktop-toolbar">
            <button type="button" className="desktop-small-button" onClick={cycleView} title={viewEntry.title}>
              {viewEntry.label}
            </button>
            <button type="button" className="desktop-small-button" onClick={() => void pasteToDesktop()}
              title="手元のクリップボードをデスクトップへ送る">貼付</button>
            <span className="desktop-toolbar-spacer" />
            <button type="button" className="desktop-small-button" onClick={() => void restartDesktop()} disabled={busy}
              title="デスクトップを再起動（開いているアプリは終了）">再起動</button>
          </div>

          <div className="desktop-screen-wrap">
            <div ref={screenRef} className="desktop-screen" />
            {connection !== 'connected' && (
              <div className={clsx('desktop-screen-overlay', connection === 'failed' && 'is-failed')} role="status">
                {connection === 'failed' ? (
                  <button type="button" className="desktop-small-button" onClick={() => { setError(''); setConnection('idle'); }}>
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
            <button type="submit" className="desktop-small-button" disabled={!text}>送信</button>
          </form>

          {remoteClipboard && (
            <div className="desktop-clipboard">
              <span title={remoteClipboard}>📋 {remoteClipboard.slice(0, 80)}</span>
              <button type="button" className="desktop-small-button" onClick={() => void copyRemoteClipboard()}>コピー</button>
              <button type="button" className="desktop-icon-button" onClick={() => setRemoteClipboard('')} aria-label="閉じる">×</button>
            </div>
          )}
        </>
      )}
      <textarea ref={imeRef} className="desktop-ime" aria-hidden="true" tabIndex={-1}
        autoCapitalize="off" autoCorrect="off" autoComplete="off" spellCheck={false} />
    </aside>
  );
}
