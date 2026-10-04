import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type PointerEvent, type WheelEvent } from 'react';
import { apiJson } from '../api';
import './computer.css';

interface ComputerStatus {
  supported: boolean;
  running: boolean;
  width: number;
  height: number;
  message?: string;
}

interface ComputerScreenshot {
  observationId: string;
  width: number;
  height: number;
  hash: string;
  image?: { type: 'image'; mimeType: string; data: string };
  unchanged?: boolean;
}

interface ComputerPaneProps {
  onClose: () => void;
}

interface ScreenPoint {
  x: number;
  y: number;
}

interface PointerPosition extends ScreenPoint {
  observationId: string;
  hash: string;
}

const SCREENSHOT_INTERVAL_MS = 1000;
const SCROLL_DEBOUNCE_MS = 180;
const API_ABORTED = 'AbortError';
const KEY_MAP: Record<string, string> = {
  Esc: 'Escape',
  ArrowUp: 'ArrowUp',
  ArrowDown: 'ArrowDown',
  ArrowLeft: 'ArrowLeft',
  ArrowRight: 'ArrowRight',
  ' ': 'Space'
};

function toComputerKey(event: KeyboardEvent<HTMLDivElement>): string | null {
  const key = KEY_MAP[event.key] || event.key;
  const named = new Set([
    'Enter', 'Escape', 'Backspace', 'Delete', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
    'Home', 'End', 'PageUp', 'PageDown', 'Space', ...Array.from({ length: 12 }, (_, index) => `F${index + 1}`)
  ]);
  if (!named.has(key) && key.length !== 1) return null;
  if (event.metaKey) return null;
  const prefix = [event.ctrlKey && 'Ctrl', event.altKey && 'Alt', event.shiftKey && 'Shift']
    .filter(Boolean)
    .join('+');
  return prefix ? `${prefix}+${key.length === 1 ? key.toUpperCase() : key}` : key;
}

function clampCoordinate(value: number, size: number): number {
  return Math.max(0, Math.min(size - 1, Math.floor(value)));
}

export function ComputerPane({ onClose }: ComputerPaneProps) {
  const [status, setStatus] = useState<ComputerStatus | null>(null);
  const [imageUrl, setImageUrl] = useState('');
  const [observationId, setObservationId] = useState('');
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [isCapturing, setIsCapturing] = useState(false);
  const [isWorking, setIsWorking] = useState(false);
  const [isKeyboardEnabled, setIsKeyboardEnabled] = useState(false);
  const [targetUrl, setTargetUrl] = useState('');
  const [typedText, setTypedText] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const statusRef = useRef<ComputerStatus | null>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const keyboardToggleRef = useRef<HTMLButtonElement>(null);
  const lifecycleRef = useRef<AbortController | null>(null);
  const observationRef = useRef('');
  const hashRef = useRef('');
  const sizeRef = useRef({ width: 960, height: 540 });
  const pointerRef = useRef<PointerPosition | null>(null);
  const captureBusyRef = useRef(false);
  const workingRef = useRef(false);
  const scrollTimeoutRef = useRef<number | null>(null);
  const pendingScrollRef = useRef(0);
  statusRef.current = status;

  const captureScreenshot = useCallback(async (clearError = true) => {
    if (!statusRef.current?.running || captureBusyRef.current || workingRef.current || pointerRef.current || document.visibilityState !== 'visible') return;
    const controller = lifecycleRef.current;
    if (!controller || controller.signal.aborted) return;
    captureBusyRef.current = true;
    setIsCapturing(true);
    if (clearError) setError('');
    try {
      const result = await apiJson<ComputerScreenshot>('/api/computer/screenshot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(hashRef.current ? { previousHash: hashRef.current } : {}),
        signal: controller.signal
      });
      observationRef.current = result.observationId;
      sizeRef.current = { width: result.width, height: result.height };
      hashRef.current = result.hash;
      setObservationId(result.observationId);
      if (result.image) {
        setImageUrl(`data:${result.image.mimeType};base64,${result.image.data}`);
      }
    } catch (captureError: unknown) {
      if (captureError instanceof DOMException && captureError.name === API_ABORTED) return;
      setError(captureError instanceof Error ? captureError.message : '画面を取得できませんでした。');
    } finally {
      captureBusyRef.current = false;
      setIsCapturing(false);
    }
  }, []);

  const refreshStatus = useCallback(async () => {
    const controller = lifecycleRef.current;
    if (!controller || controller.signal.aborted) return;
    try {
      const nextStatus = await apiJson<ComputerStatus>('/api/computer/status', { signal: controller.signal });
      statusRef.current = nextStatus;
      setStatus(nextStatus);
      setError('');
      if (!nextStatus.running) {
        observationRef.current = '';
        setObservationId('');
      }
    } catch (statusError: unknown) {
      if (statusError instanceof DOMException && statusError.name === API_ABORTED) return;
      setError(statusError instanceof Error ? statusError.message : '状態を取得できませんでした。');
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    lifecycleRef.current = controller;
    void refreshStatus();
    return () => {
      controller.abort();
      lifecycleRef.current = null;
      if (scrollTimeoutRef.current !== null) window.clearTimeout(scrollTimeoutRef.current);
    };
  }, [refreshStatus]);

  useEffect(() => {
    if (!autoRefresh || !status?.running) return;
    void captureScreenshot();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void captureScreenshot();
    }, SCREENSHOT_INTERVAL_MS);
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') void captureScreenshot();
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [autoRefresh, captureScreenshot, status?.running]);

  useEffect(() => {
    if (isKeyboardEnabled) frameRef.current?.focus();
  }, [isKeyboardEnabled]);

  const runMutation = useCallback(async <T,>(path: string, body: unknown): Promise<T | null> => {
    const controller = lifecycleRef.current;
    if (!controller || controller.signal.aborted || workingRef.current || captureBusyRef.current) return null;
    workingRef.current = true;
    setIsWorking(true);
    setError('');
    setNotice('');
    observationRef.current = '';
    setObservationId('');
    try {
      const result = await apiJson<T>(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      return result;
    } catch (mutationError: unknown) {
      if (mutationError instanceof DOMException && mutationError.name === API_ABORTED) return null;
      const message = mutationError instanceof Error ? mutationError.message : '操作に失敗しました。';
      const normalized = message.toLowerCase();
      setError(
        normalized.includes('fresh screenshot') || normalized.includes('busy') || normalized.includes('prepare the desktop')
          ? '画面が古いか、コンピューターが操作中です。画面を更新してから、もう一度操作してください。'
          : message
      );
      return null;
    } finally {
      workingRef.current = false;
      setIsWorking(false);
    }
  }, []);

  const runServiceAction = useCallback(async (action: 'prepare' | 'stop' | 'launch', body: unknown = {}) => {
    if (action !== 'stop') hashRef.current = '';
    const result = await runMutation<ComputerStatus>(`/api/computer/${action}`, body);
    if (!result) return;
    statusRef.current = result;
    setStatus(result);
    if (action === 'stop') {
      observationRef.current = '';
      setObservationId('');
      setNotice('コンピューターを停止しました。');
      return;
    }
    if (action === 'prepare') setNotice('コンピューターを起動しました。');
    else setNotice('アプリを起動しました。');
    await captureScreenshot();
  }, [captureScreenshot, runMutation]);

  const sendInput = useCallback(async (input: Record<string, unknown>, expectedObservation = observationRef.current): Promise<boolean> => {
    const currentObservation = observationRef.current;
    if (expectedObservation !== currentObservation) {
      setError('画面が更新されたため操作を取り消しました。もう一度操作してください。');
      await captureScreenshot(false);
      return false;
    }
    if (!currentObservation || workingRef.current || captureBusyRef.current) return false;
    const result = await runMutation<{ executed: boolean; requiresObservation: boolean }>('/api/computer/input', {
      observationId: currentObservation,
      ...input
    });
    if (!result) {
      await captureScreenshot(false);
      return false;
    }
    if (result.requiresObservation) await captureScreenshot();
    return true;
  }, [captureScreenshot, runMutation]);

  const imageCoordinates = useCallback((clientX: number, clientY: number): ScreenPoint | null => {
    const image = frameRef.current?.querySelector('img');
    if (!image) return null;
    const bounds = image.getBoundingClientRect();
    if (!bounds.width || !bounds.height || clientX < bounds.left || clientX > bounds.right || clientY < bounds.top || clientY > bounds.bottom) return null;
    const size = sizeRef.current;
    return {
      x: clampCoordinate(((clientX - bounds.left) / bounds.width) * size.width, size.width),
      y: clampCoordinate(((clientY - bounds.top) / bounds.height) * size.height, size.height)
    };
  }, []);

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !observationRef.current || captureBusyRef.current || workingRef.current) return;
    const position = imageCoordinates(event.clientX, event.clientY);
    if (!position) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    pointerRef.current = { ...position, observationId: observationRef.current, hash: hashRef.current };
  };

  const handlePointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const start = pointerRef.current;
    pointerRef.current = null;
    if (!start) return;
    const end = imageCoordinates(event.clientX, event.clientY);
    if (!end) return;
    if (start.observationId !== observationRef.current || start.hash !== hashRef.current) {
      setError('画面が更新されたため操作を取り消しました。もう一度操作してください。');
      void captureScreenshot(false);
      return;
    }
    const moved = Math.abs(end.x - start.x) + Math.abs(end.y - start.y) > 4;
    if (moved) void sendInput({ action: 'drag', x: start.x, y: start.y, toX: end.x, toY: end.y }, start.observationId);
    else void sendInput({ action: 'click', x: end.x, y: end.y }, start.observationId);
  };

  const handleWheel = (event: WheelEvent<HTMLDivElement>) => {
    if (!observationRef.current || isCapturing || isWorking) return;
    event.preventDefault();
    pendingScrollRef.current += event.deltaY;
    if (scrollTimeoutRef.current !== null) window.clearTimeout(scrollTimeoutRef.current);
    scrollTimeoutRef.current = window.setTimeout(() => {
      const delta = pendingScrollRef.current;
      pendingScrollRef.current = 0;
      scrollTimeoutRef.current = null;
      if (delta) void sendInput({ action: 'scroll', direction: delta < 0 ? 'up' : 'down', steps: Math.min(5, Math.max(1, Math.ceil(Math.abs(delta) / 100))) });
    }, SCROLL_DEBOUNCE_MS);
  };

  const handleComputerKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!isKeyboardEnabled) return;
    if (event.ctrlKey && event.shiftKey && event.key === 'Escape') {
      event.preventDefault();
      setIsKeyboardEnabled(false);
      frameRef.current?.blur();
      keyboardToggleRef.current?.focus();
      return;
    }
    const key = toComputerKey(event);
    if (!key) return;
    event.preventDefault();
    if (!observationRef.current || isCapturing || isWorking) return;
    void sendInput({ action: 'key', key });
  };

  const handleTypeSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!typedText || !observationRef.current) return;
    void sendInput({ action: 'type', text: typedText }).then((executed) => {
      if (executed) setTypedText('');
    });
  };

  const handleLaunchBrowser = () => {
    const url = targetUrl.trim();
    void runServiceAction('launch', { app: 'browser', ...(url ? { url } : {}) });
  };

  if (status && !status.supported) {
    return (
      <aside className="computer-pane" id="computer-pane" aria-label="コンピューター画面">
        <header className="computer-pane-header">
          <h2>コンピューター</h2>
          <button type="button" className="computer-icon-button" onClick={onClose} aria-label="コンピューターパネルを閉じる">×</button>
        </header>
        <div className="computer-empty-state">
          <span className="computer-status-dot unsupported" aria-hidden="true" />
          <h3>この環境では利用できません</h3>
          <p>{status.message || 'コンピューター操作はサポートされていません。'}</p>
        </div>
      </aside>
    );
  }

  return (
    <aside className="computer-pane" id="computer-pane" aria-label="コンピューター画面">
      <header className="computer-pane-header">
        <div className="computer-pane-heading">
          <h2>コンピューター</h2>
          {status && <span className={`computer-status-dot ${status.running ? 'running' : 'stopped'}`} aria-label={status.running ? '起動中' : '停止中'} title={status.running ? '起動中' : '停止中'} />}
        </div>
        <div className="computer-pane-header-actions">
          <button type="button" className="computer-icon-button" onClick={() => void refreshStatus()} aria-label="状態を更新" title="状態を更新">↻</button>
          <button type="button" className="computer-icon-button" onClick={onClose} aria-label="コンピューターパネルを閉じる">×</button>
        </div>
      </header>

      <div className="computer-pane-content">
        {error && <p className="computer-feedback error" role="alert">{error}</p>}
        {notice && <p className="computer-feedback" role="status">{notice}</p>}
        {!status && !error && <p className="computer-loading" role="status">状態を確認しています…</p>}
        {status?.running ? (
          <>
            <div className="computer-screen-toolbar">
              <label className="computer-auto-refresh">
                <input type="checkbox" checked={autoRefresh} onChange={(event) => setAutoRefresh(event.target.checked)} />
                自動更新（1秒）
              </label>
              <button type="button" className="computer-small-button" onClick={() => void captureScreenshot()} disabled={isCapturing || isWorking}>
                {isCapturing ? '取得中…' : '画面を更新'}
              </button>
            </div>
            <div
              ref={frameRef}
              className={`computer-screen ${isKeyboardEnabled ? 'keyboard-enabled' : ''}`}
              tabIndex={0}
              aria-label="リモートコンピューター画面。クリックやドラッグで操作し、キーボード操作を有効にするとキーを送信できます。"
              onPointerDown={handlePointerDown}
              onPointerUp={handlePointerUp}
              onPointerCancel={() => { pointerRef.current = null; }}
              onWheel={handleWheel}
              onKeyDown={handleComputerKey}
              onContextMenu={(event) => event.preventDefault()}
            >
              {imageUrl ? (
                <img src={imageUrl} alt="現在のコンピューター画面" draggable={false} />
              ) : (
                <div className="computer-screen-placeholder">{isCapturing ? '画面を取得しています…' : '画面を取得してください'}</div>
              )}
              {isCapturing && imageUrl && <span className="computer-capture-indicator" role="status">更新中…</span>}
            </div>
            <div className="computer-control-row">
              <button
                ref={keyboardToggleRef}
                type="button"
                className={`computer-small-button ${isKeyboardEnabled ? 'active' : ''}`}
                onClick={() => setIsKeyboardEnabled((enabled) => !enabled)}
                disabled={!observationId || isWorking || isCapturing}
              >
                {isKeyboardEnabled ? 'キーボード操作中（クリックで解除）' : 'キーボード操作を有効化'}
              </button>
              <span className="computer-hint">Ctrl+Shift+Escでキーボード操作を解除</span>
            </div>
            <form className="computer-type-form" onSubmit={handleTypeSubmit}>
              <label htmlFor="computer-type-text">文字入力</label>
              <input
                id="computer-type-text"
                type="text"
                value={typedText}
                onChange={(event) => setTypedText(event.target.value)}
                placeholder="文字を入力して送信"
                disabled={!observationId || isWorking || isCapturing}
              />
              <button type="submit" className="computer-small-button" disabled={!typedText || !observationId || isWorking || isCapturing}>送信</button>
            </form>
            <p className="computer-observation-hint">操作ごとに画面を取り直します。画面を閉じてもコンピューターは停止しません。</p>
            <button type="button" className="computer-stop-button" onClick={() => void runServiceAction('stop')} disabled={isWorking || isCapturing}>コンピューターを停止</button>
          </>
        ) : status?.supported ? (
          <div className="computer-empty-state">
            <span className="computer-status-dot stopped" aria-hidden="true" />
            <h3>コンピューターは停止中です</h3>
            <p>起動すると、このDeck IDEとは独立したデスクトップ環境が開きます。</p>
            <button type="button" className="computer-primary-button" onClick={() => void runServiceAction('prepare')} disabled={isWorking || !status}>
              {isWorking ? '起動しています…' : 'コンピューターを起動'}
            </button>
          </div>
        ) : null}
      </div>

      {status?.running && (
        <footer className="computer-pane-footer">
          <label htmlFor="computer-browser-url">ブラウザーを開くURL</label>
          <div className="computer-launch-row">
            <input id="computer-browser-url" type="url" value={targetUrl} onChange={(event) => setTargetUrl(event.target.value)} placeholder="https://example.com" />
            <button type="button" className="computer-small-button" onClick={handleLaunchBrowser} disabled={isWorking || isCapturing}>ブラウザー</button>
            <button type="button" className="computer-small-button" onClick={() => void runServiceAction('launch', { app: 'terminal' })} disabled={isWorking || isCapturing}>ターミナル</button>
          </div>
        </footer>
      )}
    </aside>
  );
}
