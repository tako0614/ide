import { useCallback, useEffect, useRef, useState, type FocusEvent, type FormEvent, type KeyboardEvent, type PointerEvent, type WheelEvent } from 'react';
import { apiJson, AUTH_REQUIRED_EVENT } from '../api';
import { computerKeyboardAction, createComputerReleaseScheduler, createComputerScheduler, drainComputerActions, ensureFreshHumanControl, ensureServiceControl, fittedImageRect, mapScreenPoint, needsHumanClaim, queueComputerAction, sameDisplayedFrame, shouldReleaseHumanControl, type DisplayedFrame, type QueuedComputerAction, type ScreenPoint } from './computer-helpers';
import { ComputerVncView, type VncViewState } from './ComputerVncView';
import './computer.css';

type Control = { mode: 'shared' | 'human' | 'agent'; mine: boolean; expiresAt?: number };
type ComputerStatus = {
  supported: boolean; running: boolean; width: number; height: number; message?: string;
  epoch?: number; transport?: 'sampled-jpeg' | 'private-rfb'; control?: Control;
  capabilities?: { unicode: boolean; clipboard: boolean; developedApps?: boolean };
  capture?: { ready: boolean; capturedAt?: number; error?: string };
};
type AppWindow = { id: string; title: string };
type AppInstance = { id: string; app: string; label: string; windows: AppWindow[] };
type AppInventory = { apps: Array<{ id: string; label: string; available: boolean; reason?: string }>; instances: AppInstance[]; control: Control; developmentScopes?: Array<{ id: string; root: string }> };
type ComputerScreenshot = { observationId: string; width: number; height: number; hash: string; epoch?: number; image?: { type: 'image'; mimeType: string; data: string }; unchanged?: boolean };
type PointerPosition = ScreenPoint & { observationId: string; hash: string; button: 'left' | 'right' | 'middle'; pointerId: number };
type PendingHandoffPointer = { pointerId: number; button: 'left' | 'right' | 'middle'; start: ScreenPoint; end?: ScreenPoint; frame: DisplayedFrame; ready: boolean | null; finishing: boolean; doubleClick: boolean };

interface ComputerPaneProps { onClose: () => void }

const POLL_MS = 300;
const STATUS_MS = 3000;
const LEASE_MS = 5000;
const CONTROL_IDLE_MS = 12_000;
const MAX_INPUT_QUEUE = 32;
const SCROLL_DEBOUNCE_MS = 180;
const delay = (ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
  if (signal.aborted) return resolve();
  let abort = () => {};
  const finish = () => { signal.removeEventListener('abort', abort); resolve(); };
  const timer = window.setTimeout(finish, ms);
  abort = () => { window.clearTimeout(timer); finish(); };
  signal.addEventListener('abort', abort, { once: true });
});
const decodeImage = (image: HTMLImageElement, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  let settled = false;
  const finish = (callback: () => void) => {
    if (settled) return;
    settled = true;
    signal.removeEventListener('abort', abort);
    callback();
  };
  const abort = () => finish(() => reject(new DOMException('Image decode aborted', 'AbortError')));
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) { abort(); return; }
  try { void image.decode().then(() => finish(resolve), (reason: unknown) => finish(() => reject(reason))); }
  catch (reason: unknown) { finish(() => reject(reason)); }
});

export function ComputerPane({ onClose }: ComputerPaneProps) {
  const [status, setStatus] = useState<ComputerStatus | null>(null);
  const [inventory, setInventory] = useState<AppInventory | null>(null);
  const [imageUrl, setImageUrl] = useState('');
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [jpegFallback, setJpegFallback] = useState(false);
  const [vncViewState, setVncViewState] = useState<VncViewState>('disconnected');
  const [authBlocked, setAuthBlocked] = useState(false);
  const [isCapturing, setIsCapturing] = useState(false);
  const [isWorking, setIsWorking] = useState(false);
  const [doubleClickMode, setDoubleClickMode] = useState(false);
  const [isMaximized, setIsMaximized] = useState(false);
  const [targetUrl, setTargetUrl] = useState('');
  const [typedText, setTypedText] = useState('');
  const [queueSize, setQueueSize] = useState(0);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [isComposing, setIsComposing] = useState(false);
  const [showDevelopedApp, setShowDevelopedApp] = useState(false);
  const [developedExecutable, setDevelopedExecutable] = useState('');
  const [developedArgs, setDevelopedArgs] = useState('[]');
  const [developedCwd, setDevelopedCwd] = useState('.');
  const [selectedScopeId, setSelectedScopeId] = useState('');
  const statusRef = useRef<ComputerStatus | null>(null);
  const inventoryRef = useRef<AppInventory | null>(null);
  const paneRef = useRef<HTMLElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const lifecycleRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(false);
  const teardownTicketRef = useRef(0);
  const claimIssuedRef = useRef(false);
  const claimTransportRef = useRef<Promise<Control> | null>(null);
  const observationRef = useRef('');
  const hashRef = useRef('');
  const imageReadyRef = useRef(false);
  const epochRef = useRef<number | undefined>();
  const sizeRef = useRef({ width: 960, height: 540 });
  const pointerRef = useRef<PointerPosition | null>(null);
  const handoffPointerRef = useRef<PendingHandoffPointer | null>(null);
  const captureBusyRef = useRef(false);
  const workingRef = useRef(false);
  const queueRef = useRef<QueuedComputerAction[]>([]);
  const scheduleRef = useRef(createComputerScheduler());
  const drainingRef = useRef(false);
  const scrollTimeoutRef = useRef<number | null>(null);
  const pendingScrollRef = useRef(0);
  const scrollAnchorRef = useRef<{ observationId: string; hash: string } | null>(null);
  const lastStatusAtRef = useRef(0);
  const lastHeartbeatRef = useRef(0);
  const pollFailuresRef = useRef(0);
  const inputSuspendedRef = useRef(true);
  const scenePendingRef = useRef(0);
  const composingRef = useRef(false);
  const compositionUntilRef = useRef(0);
  const claimPromiseRef = useRef<Promise<boolean> | null>(null);
  const idleTimerRef = useRef<number | null>(null);
  const lastGuiActivityRef = useRef(Date.now());
  const jpegFallbackRef = useRef(false);
  const vncConnectedEpochRef = useRef<number | undefined>();
  const vncInputPossibleRef = useRef(false);
  const releaseOnIdleRef = useRef<() => void>(() => undefined);
  const scheduleIdleCheckRef = useRef<() => void>(() => undefined);
  statusRef.current = status;
  inventoryRef.current = inventory;
  jpegFallbackRef.current = jpegFallback;

  const clearFrame = useCallback(() => {
    inputSuspendedRef.current = true;
    observationRef.current = '';
    hashRef.current = '';
    imageReadyRef.current = false;
    setImageUrl('');
    pointerRef.current = null;
  }, []);

  const clearPending = useCallback(() => {
    queueRef.current.length = 0;
    setQueueSize(0);
    pointerRef.current = null;
    pendingScrollRef.current = 0;
    scrollAnchorRef.current = null;
    if (scrollTimeoutRef.current !== null) window.clearTimeout(scrollTimeoutRef.current);
    scrollTimeoutRef.current = null;
    setDoubleClickMode(false);
  }, []);

  const stopIdleCheck = useCallback(() => {
    if (idleTimerRef.current !== null) window.clearTimeout(idleTimerRef.current);
    idleTimerRef.current = null;
  }, []);

  const scheduleIdleCheck = useCallback(() => {
    stopIdleCheck();
    const elapsed = Date.now() - lastGuiActivityRef.current;
    idleTimerRef.current = window.setTimeout(() => {
      idleTimerRef.current = null;
      const control = statusRef.current?.control || inventoryRef.current?.control;
      const activeWork = drainingRef.current || scenePendingRef.current > 0 || pointerRef.current !== null || handoffPointerRef.current !== null;
      const focused = !!paneRef.current?.contains(document.activeElement);
      if (shouldReleaseHumanControl(control, Date.now() - lastGuiActivityRef.current, activeWork, focused, CONTROL_IDLE_MS)) releaseOnIdleRef.current();
      else if (control?.mine) scheduleIdleCheckRef.current();
    }, Math.max(1000, CONTROL_IDLE_MS - elapsed));
  }, [stopIdleCheck]);
  scheduleIdleCheckRef.current = scheduleIdleCheck;

  const markGuiActivity = useCallback(() => {
    lastGuiActivityRef.current = Date.now();
    scheduleIdleCheck();
  }, [scheduleIdleCheck]);

  const sendIndependentRelease = useCallback(async () => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 3000);
    try {
      const result = await apiJson<Control>('/api/computer/control', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'release' }), signal: controller.signal, keepalive: true,
      }, false);
      claimIssuedRef.current = false;
      vncInputPossibleRef.current = false;
      if (mountedRef.current && lifecycleRef.current && !lifecycleRef.current.signal.aborted) {
        handoffPointerRef.current = null;
        clearPending();
        clearFrame();
        inventoryRef.current = inventoryRef.current ? { ...inventoryRef.current, control: result } : null;
        statusRef.current = statusRef.current ? { ...statusRef.current, control: result } : null;
        setInventory((current) => current ? { ...current, control: result } : current);
        setStatus((current) => current ? { ...current, control: result } : current);
        setNotice('操作権を引き渡しました。');
      }
    } catch (failure: unknown) {
      if (mountedRef.current && lifecycleRef.current && !lifecycleRef.current.signal.aborted)
        setError(failure instanceof Error ? failure.message : '操作権を引き渡せませんでした。');
    } finally { window.clearTimeout(timer); }
  }, [clearFrame, clearPending]);
  const scheduleReleaseRef = useRef<(() => Promise<void>) | null>(null);
  if (!scheduleReleaseRef.current) scheduleReleaseRef.current = createComputerReleaseScheduler(scheduleRef.current, sendIndependentRelease);

  const refreshStatus = useCallback(async (signal?: AbortSignal) => {
    const controller = lifecycleRef.current;
    const activeSignal = signal || controller?.signal;
    if (!activeSignal || activeSignal.aborted) return;
    const nextStatus = await apiJson<ComputerStatus>('/api/computer/status', { signal: activeSignal });
    if (activeSignal.aborted) return;
    if (epochRef.current !== undefined && nextStatus.epoch !== undefined && epochRef.current !== nextStatus.epoch) {
      clearPending(); clearFrame(); handoffPointerRef.current = null;
      vncConnectedEpochRef.current = undefined;
      vncInputPossibleRef.current = false;
      setVncViewState('disconnected');
      setJpegFallback(false);
    }
    if (statusRef.current?.control?.mine && !nextStatus.control?.mine) { clearPending(); clearFrame(); handoffPointerRef.current = null; stopIdleCheck(); }
    epochRef.current = nextStatus.epoch;
    statusRef.current = nextStatus;
    setStatus(nextStatus);
    if (!nextStatus.running) {
      clearPending(); clearFrame(); handoffPointerRef.current = null; stopIdleCheck();
      vncConnectedEpochRef.current = undefined;
      vncInputPossibleRef.current = false;
      setVncViewState('disconnected');
      setJpegFallback(false);
    }
    lastStatusAtRef.current = Date.now();
  }, [clearFrame, clearPending, stopIdleCheck]);

  const refreshInventory = useCallback(async (signal: AbortSignal) => {
    const next = await apiJson<AppInventory>('/api/computer/apps', { signal });
    if (!signal.aborted) {
      if ((inventoryRef.current?.control.mine || statusRef.current?.control?.mine) && !next.control.mine) { clearPending(); clearFrame(); handoffPointerRef.current = null; stopIdleCheck(); }
      inventoryRef.current = next;
      setInventory(next);
      statusRef.current = statusRef.current ? { ...statusRef.current, control: next.control } : null;
      setStatus((current) => current ? { ...current, control: next.control } : current);
    }
  }, [clearFrame, clearPending, stopIdleCheck]);

  const captureScreenshot = useCallback(async (clearError = true): Promise<boolean> => {
    if (!statusRef.current?.running || captureBusyRef.current || workingRef.current || pointerRef.current || document.visibilityState !== 'visible') return false;
    const controller = lifecycleRef.current;
    if (!controller || controller.signal.aborted) return false;
    captureBusyRef.current = true;
    setIsCapturing(true);
    if (clearError) setError('');
    try {
      const result = await apiJson<ComputerScreenshot>('/api/computer/screenshot', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(hashRef.current ? { previousHash: hashRef.current } : {}), signal: controller.signal
      });
      if (controller.signal.aborted) return false;
      const epoch = result.epoch ?? epochRef.current;
      if (epochRef.current !== undefined && epoch !== undefined && epochRef.current !== epoch) { clearPending(); clearFrame(); handoffPointerRef.current = null; }
      epochRef.current = epoch;
      if (result.image) {
        const nextUrl = `data:${result.image.mimeType};base64,${result.image.data}`;
        const decoded = new Image();
        decoded.src = nextUrl;
        await decodeImage(decoded, controller.signal);
        if (controller.signal.aborted || lifecycleRef.current !== controller) return false;
        imageReadyRef.current = true;
        setImageUrl(nextUrl);
      } else if (!result.unchanged || !imageReadyRef.current) {
        clearFrame();
        return false;
      }
      observationRef.current = result.observationId;
      sizeRef.current = { width: result.width, height: result.height };
      hashRef.current = result.hash;
      if (scenePendingRef.current === 0 && statusRef.current?.control?.mine) inputSuspendedRef.current = false;
      return true;
    } catch (captureError: unknown) {
      if (captureError instanceof DOMException && captureError.name === 'AbortError') return false;
      if (controller.signal.aborted || lifecycleRef.current !== controller) return false;
      clearFrame();
      const message = captureError instanceof Error ? captureError.message : '画面を取得できませんでした。';
      setError(message);
      return false;
    } finally {
      captureBusyRef.current = false;
      if (!controller.signal.aborted && lifecycleRef.current === controller) setIsCapturing(false);
    }
  }, [clearFrame, clearPending]);

  const runMutation = useCallback(async <T,>(path: string, body: unknown): Promise<T | null> => {
    const controller = lifecycleRef.current;
    if (!controller || controller.signal.aborted) return null;
    workingRef.current = true;
    setIsWorking(true);
    setError('');
    try {
      const result = await apiJson<T>(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal });
      return controller.signal.aborted ? null : result;
    } catch (mutationError: unknown) {
      if (mutationError instanceof DOMException && mutationError.name === 'AbortError') return null;
      if (!controller.signal.aborted && lifecycleRef.current === controller)
        setError(mutationError instanceof Error ? mutationError.message : '操作に失敗しました。');
      return null;
    } finally {
      workingRef.current = false;
      if (!controller.signal.aborted && lifecycleRef.current === controller) setIsWorking(false);
    }
  }, []);

  const requestControlInternal = useCallback(async (action: 'claim' | 'heartbeat', captureAfterClaim = true) => {
    if (!mountedRef.current || !lifecycleRef.current || lifecycleRef.current.signal.aborted) return false;
    if (action === 'claim') { clearPending(); clearFrame(); }
    let result: Control | null = null;
    if (action === 'claim') {
      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), 3000);
      claimIssuedRef.current = true;
      workingRef.current = true;
      if (mountedRef.current) { setIsWorking(true); setError(''); }
      const transport = apiJson<Control>('/api/computer/control', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'claim' }), signal: controller.signal, keepalive: true,
      }, false);
      claimTransportRef.current = transport;
      try { result = await transport; }
      catch (failure: unknown) {
        if (mountedRef.current && lifecycleRef.current && !lifecycleRef.current.signal.aborted)
          setError(failure instanceof Error ? failure.message : '操作権を取得できませんでした。');
      } finally {
        window.clearTimeout(timer);
        if (claimTransportRef.current === transport) claimTransportRef.current = null;
        workingRef.current = false;
        if (mountedRef.current && lifecycleRef.current && !lifecycleRef.current.signal.aborted) setIsWorking(false);
      }
      if (!mountedRef.current || !lifecycleRef.current || lifecycleRef.current.signal.aborted) return false;
    } else result = await runMutation<Control>('/api/computer/control', { action });
    if (!result) return false;
    if ((inventoryRef.current?.control.mine || statusRef.current?.control?.mine) && !result.mine) { clearPending(); clearFrame(); stopIdleCheck(); }
    setInventory((current) => current ? { ...current, control: result } : current);
    setStatus((current) => current ? { ...current, control: result } : current);
    inventoryRef.current = inventoryRef.current ? { ...inventoryRef.current, control: result } : null;
    statusRef.current = statusRef.current ? { ...statusRef.current, control: result } : null;
    if (action === 'claim') setNotice('操作権を取得しました。');
    lastHeartbeatRef.current = Date.now();
    if (action === 'claim') { markGuiActivity(); if (captureAfterClaim) await captureScreenshot(false); }
    return true;
  }, [captureScreenshot, clearFrame, clearPending, markGuiActivity, runMutation, stopIdleCheck]);

  const requestControl = useCallback(() => {
    scenePendingRef.current++;
    inputSuspendedRef.current = true;
    return scheduleRef.current(async () => {
      try { return await requestControlInternal('claim'); }
      finally {
        scenePendingRef.current--;
        if (scenePendingRef.current === 0 && imageReadyRef.current && observationRef.current && statusRef.current?.control?.mine) inputSuspendedRef.current = false;
      }
    });
  }, [requestControlInternal]);

  const ensureHumanControl = useCallback((): Promise<boolean> => {
    if (claimPromiseRef.current) return claimPromiseRef.current;
    if (scenePendingRef.current > 0) return Promise.resolve(false);
    const pending = ensureFreshHumanControl(
      statusRef.current?.control || inventoryRef.current?.control, Date.now(),
      () => requestControl(),
      () => scheduleRef.current(() => captureScreenshot(false)),
      () => !!statusRef.current?.control?.mine && !!imageReadyRef.current && !!observationRef.current,
    ).catch((failure: unknown) => {
      if (lifecycleRef.current && !lifecycleRef.current.signal.aborted) setError(failure instanceof Error ? failure.message : '操作権を取得できませんでした。');
      return false;
    });
    claimPromiseRef.current = pending;
    void pending.then(() => { if (claimPromiseRef.current === pending) claimPromiseRef.current = null; });
    return pending;
  }, [captureScreenshot, requestControl]);

  const releaseGuiControl = useCallback((force = false): Promise<void> => {
    if (!(statusRef.current?.control?.mine || claimIssuedRef.current || claimTransportRef.current || claimPromiseRef.current || scenePendingRef.current > 0 || vncInputPossibleRef.current)) return Promise.resolve();
    if (!force && paneRef.current?.contains(document.activeElement)) return Promise.resolve();
    handoffPointerRef.current = null;
    clearPending();
    clearFrame();
    stopIdleCheck();
    return scheduleReleaseRef.current!();
  }, [clearFrame, clearPending, stopIdleCheck]);
  releaseOnIdleRef.current = () => { void releaseGuiControl(true); };

  const closePane = useCallback(async () => {
    let timer: number | undefined;
    try {
      await Promise.race([
        releaseGuiControl(true).catch(() => undefined),
        new Promise<void>((resolve) => { timer = window.setTimeout(resolve, 2000); }),
      ]);
    } finally { if (timer !== undefined) window.clearTimeout(timer); }
    if (mountedRef.current) onClose();
  }, [onClose, releaseGuiControl]);

  const runServiceAction = useCallback((action: 'prepare' | 'stop' | 'launch' | 'focus' | 'close', body: unknown = {}) => {
    scenePendingRef.current++;
    inputSuspendedRef.current = true;
    clearPending();
    return scheduleRef.current(async () => {
      try {
        if (!mountedRef.current || !lifecycleRef.current || lifecycleRef.current.signal.aborted) return;
        const usesVnc = action !== 'prepare' && !jpegFallbackRef.current;
        if (!await ensureServiceControl(
          action,
          () => statusRef.current?.control || inventoryRef.current?.control,
          () => requestControlInternal('claim', !usesVnc && jpegFallbackRef.current),
          usesVnc ? null : () => captureScreenshot(false),
          () => usesVnc
            ? vncConnectedEpochRef.current !== undefined && vncConnectedEpochRef.current === statusRef.current?.epoch
            : action === 'prepare' || (imageReadyRef.current && !!observationRef.current),
        )) {
          if (mountedRef.current) setError(action === 'prepare'
            ? '操作権を確認できず、コンピューターを起動できませんでした。もう一度操作してください。'
            : usesVnc ? 'リアルタイム画面の接続と操作権を確認できませんでした。接続後にもう一度操作してください。'
              : '操作権と新しい画面を確認できませんでした。もう一度操作してください。');
          return;
        }
        markGuiActivity();
        const endpoint = action === 'focus' ? '/api/computer/focus' : action === 'close' ? '/api/computer/close' : `/api/computer/${action}`;
        clearFrame();
        const result = await runMutation<ComputerStatus & { instanceId?: string }>(endpoint, body);
        if (!result) return;
        statusRef.current = result;
        setStatus(result);
        setNotice(action === 'prepare' ? 'コンピューターを起動しました。' : action === 'stop' ? 'コンピューターを停止しました。' : action === 'launch' ? 'アプリを起動しました。' : action === 'close' ? 'アプリを閉じました。' : 'ウィンドウを選択しました。');
        const signal = lifecycleRef.current?.signal;
        if (signal && !signal.aborted) await refreshInventory(signal).catch(() => undefined);
        if (result.running && jpegFallbackRef.current) await captureScreenshot();
      } finally {
        scenePendingRef.current--;
        if (scenePendingRef.current === 0 && imageReadyRef.current && observationRef.current && statusRef.current?.control?.mine) inputSuspendedRef.current = false;
      }
    });
  }, [captureScreenshot, clearFrame, clearPending, markGuiActivity, refreshInventory, requestControlInternal, runMutation]);

  const enqueueInput = useCallback((action: Record<string, unknown>, anchor?: { observationId: string; hash: string }): boolean => {
    if (!lifecycleRef.current || lifecycleRef.current.signal.aborted) return false;
    if (inputSuspendedRef.current) { setError('操作権または画面の切り替え中です。最新の画面を待ってください。'); return false; }
    const semantic = !anchor && ['key', 'type', 'scroll'].includes(String(action.action));
    if (!imageReadyRef.current || (!observationRef.current && !semantic) || (anchor && (anchor.observationId !== observationRef.current || anchor.hash !== hashRef.current))) {
      setError('画面が更新されたため操作を受け付けませんでした。最新の画面で操作してください。');
      return false;
    }
    const control = statusRef.current?.control || inventoryRef.current?.control;
    if (!control?.mine) {
      setError('操作権を確認できません。画面にフォーカスしてから操作してください。');
      return false;
    }
    if (!queueComputerAction(queueRef.current, { action, anchor }, MAX_INPUT_QUEUE)) {
      setQueueSize(queueRef.current.length);
      setError(`入力待ちが上限（${MAX_INPUT_QUEUE}件）です。画面が追いつくまで新しい入力を受け付けません。`);
      return false;
    }
    setQueueSize(queueRef.current.length);
    markGuiActivity();
    void drainQueueRef.current();
    return true;
  }, [markGuiActivity]);

  const drainQueueRef = useRef<() => Promise<void>>(async () => undefined);

  const drainQueue = useCallback(async () => {
    if (drainingRef.current || !queueRef.current.length) return;
    drainingRef.current = true;
    try {
      return await scheduleRef.current(async () => {
        const outcome = await drainComputerActions(queueRef.current,
          () => observationRef.current && imageReadyRef.current ? { observationId: observationRef.current, hash: hashRef.current } : null,
          async (observationId, actions) => {
            const result = await runMutation<{ executed: boolean }>('/api/computer/input', { observationId, actions });
            if (!mountedRef.current || lifecycleRef.current?.signal.aborted) return false;
            if (!result?.executed) { clearPending(); clearFrame(); return false; }
            observationRef.current = ''; // single-use, including while the following image decodes
            return true;
          },
          () => captureScreenshot(false),
          () => { if (mountedRef.current) setError('画面が更新されたため、未送信のポインター操作を取り消しました。'); },
          () => { if (mountedRef.current) setQueueSize(queueRef.current.length); },
          async () => {
            if (!mountedRef.current || lifecycleRef.current?.signal.aborted) return false;
            if (!(statusRef.current?.control || inventoryRef.current?.control)?.mine) return false;
            if (Date.now() - lastHeartbeatRef.current >= LEASE_MS && !await requestControlInternal('heartbeat')) return false;
            markGuiActivity();
            return !!(statusRef.current?.control || inventoryRef.current?.control)?.mine;
          });
        if (mountedRef.current && outcome === 'ambiguous') setError('入力結果を確認できません。最新の画面を取得してから操作してください。');
        if (mountedRef.current && outcome === 'stopped') { clearFrame(); setError('操作権を確認できず、未送信の入力を取り消しました。'); }
        return outcome;
      });
    } finally {
      drainingRef.current = false;
      if (queueRef.current.length && observationRef.current && lifecycleRef.current && !lifecycleRef.current.signal.aborted) {
        void drainQueueRef.current();
      }
    }
  }, [captureScreenshot, clearFrame, clearPending, markGuiActivity, requestControlInternal, runMutation]);
  drainQueueRef.current = async () => { await drainQueue(); };

  const imageCoordinates = useCallback((clientX: number, clientY: number): ScreenPoint | null => {
    const image = imageRef.current;
    if (!image) return null;
    const rect = fittedImageRect(image.getBoundingClientRect(), sizeRef.current);
    return mapScreenPoint(rect, sizeRef.current, clientX, clientY);
  }, []);

  const displayedFrame = useCallback((): DisplayedFrame | null => {
    const image = imageRef.current;
    const epoch = epochRef.current;
    if (!image || !imageReadyRef.current || !hashRef.current || epoch === undefined) return null;
    const size = { ...sizeRef.current };
    return { hash: hashRef.current, epoch, size, rect: fittedImageRect(image.getBoundingClientRect(), size) };
  }, []);

  const sendSemanticAction = useCallback(async (action: Record<string, unknown>, requireFrameFocus = false): Promise<boolean> => {
    if (!await ensureHumanControl()) { if (mountedRef.current) setError('操作権と新しい画面を確認できませんでした。もう一度操作してください。'); return false; }
    if (!document.hasFocus() || !paneRef.current?.contains(document.activeElement) || (requireFrameFocus && document.activeElement !== frameRef.current)) return false;
    return enqueueInput(action);
  }, [enqueueInput, ensureHumanControl]);

  const handlePaneBlur = (event: FocusEvent<HTMLElement>) => {
    if (event.relatedTarget instanceof Node && paneRef.current?.contains(event.relatedTarget)) return;
    void releaseGuiControl();
  };

  useEffect(() => {
    const controller = new AbortController();
    mountedRef.current = true;
    teardownTicketRef.current++;
    lifecycleRef.current = controller;
    const handleAuthFailure = () => {
      controller.abort();
      lifecycleRef.current = null;
      setAuthBlocked(true);
      vncConnectedEpochRef.current = undefined;
      clearPending();
      clearFrame();
      handoffPointerRef.current = null;
      stopIdleCheck();
      setError('認証が必要です。画面操作を停止しました。');
    };
    window.addEventListener(AUTH_REQUIRED_EVENT, handleAuthFailure);
    const handleWindowBlur = () => { void releaseGuiControl(true); };
    window.addEventListener('blur', handleWindowBlur);
    const start = async () => {
      try {
        await scheduleRef.current(async () => {
          await refreshStatus(controller.signal);
          if (statusRef.current?.running) await refreshInventory(controller.signal);
        });
      }
      catch (initialError) { if (!controller.signal.aborted) setError(initialError instanceof Error ? initialError.message : '状態を取得できませんでした。'); }
    };
    void start();
    return () => {
      mountedRef.current = false;
      const teardownTicket = ++teardownTicketRef.current;
      const shouldRelease = claimIssuedRef.current || !!claimTransportRef.current || !!statusRef.current?.control?.mine || vncInputPossibleRef.current;
      controller.abort();
      lifecycleRef.current = null;
      window.removeEventListener(AUTH_REQUIRED_EVENT, handleAuthFailure);
      window.removeEventListener('blur', handleWindowBlur);
      queueRef.current.length = 0;
      pointerRef.current = null;
      pendingScrollRef.current = 0;
      scrollAnchorRef.current = null;
      if (scrollTimeoutRef.current !== null) window.clearTimeout(scrollTimeoutRef.current);
      scrollTimeoutRef.current = null;
      inputSuspendedRef.current = true;
      observationRef.current = '';
      imageReadyRef.current = false;
      handoffPointerRef.current = null;
      stopIdleCheck();
      queueMicrotask(() => {
        if (shouldRelease && !mountedRef.current && teardownTicketRef.current === teardownTicket)
          void scheduleReleaseRef.current?.();
      });
    };
  }, [clearFrame, clearPending, refreshInventory, refreshStatus, releaseGuiControl, stopIdleCheck]);

  useEffect(() => {
    let cancelled = false;
    const controller = lifecycleRef.current;
    if (!controller) return;
    const poll = async () => {
      while (!cancelled && !controller.signal.aborted) {
        const tickStartedAt = Date.now();
        if (document.visibilityState === 'visible') {
          try {
            await scheduleRef.current(async () => {
              if (cancelled || controller.signal.aborted) return;
              if (Date.now() - lastStatusAtRef.current >= STATUS_MS) {
                await refreshStatus(controller.signal);
                if (statusRef.current?.running) await refreshInventory(controller.signal);
              }
              if (!statusRef.current?.running) return;
              if (jpegFallbackRef.current && !queueRef.current.length && autoRefresh && !pointerRef.current && !await captureScreenshot(false)) throw new Error('画面を取得できませんでした。');
            });
            if (queueRef.current.length && await drainQueue() === 'needs-frame') throw new Error('画面を取得できませんでした。');
            pollFailuresRef.current = 0;
          } catch (pollError) {
            if (!controller.signal.aborted) { pollFailuresRef.current = Math.min(5, pollFailuresRef.current + 1); setError(pollError instanceof Error ? pollError.message : '更新に失敗しました。'); }
          }
        }
        const interval = statusRef.current?.running && jpegFallbackRef.current && autoRefresh ? POLL_MS : STATUS_MS;
        await delay(Math.max(0, Math.min(5000, interval * (2 ** pollFailuresRef.current)) - (Date.now() - tickStartedAt)), controller.signal);
      }
    };
    void poll();
    const handleVisibility = () => { if (document.visibilityState === 'visible') lastStatusAtRef.current = 0; else void releaseGuiControl(true); };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => { cancelled = true; document.removeEventListener('visibilitychange', handleVisibility); };
  }, [autoRefresh, captureScreenshot, drainQueue, refreshInventory, refreshStatus, releaseGuiControl]);

  const finishHandoffPointer = async (pending: PendingHandoffPointer) => {
    if (pending.finishing || pending.ready === null || !pending.end) return;
    pending.finishing = true;
    if (pending.ready) {
      await new Promise<void>((resolve) => {
        let completed = false;
        const done = () => { if (completed) return; completed = true; window.clearTimeout(timer); resolve(); };
        const timer = window.setTimeout(done, 100);
        window.requestAnimationFrame(done);
      });
    }
    if (handoffPointerRef.current !== pending) return;
    handoffPointerRef.current = null;
    const fresh = displayedFrame();
    if (!pending.ready || !fresh || !sameDisplayedFrame(pending.frame, fresh) ||
      !document.hasFocus() || document.activeElement !== frameRef.current) {
      setNotice('画面が変わったためクリック操作を送信しませんでした。新しい画面でもう一度操作してください。');
      return;
    }
    const moved = Math.abs(pending.end.x - pending.start.x) + Math.abs(pending.end.y - pending.start.y) > 4;
    const doubleClick = pending.doubleClick && pending.button === 'left' && !moved;
    const action = moved && pending.button === 'left'
      ? { action: 'drag', x: pending.start.x, y: pending.start.y, toX: pending.end.x, toY: pending.end.y }
      : { action: 'click', x: pending.end.x, y: pending.end.y, button: pending.button, count: doubleClick ? 2 : 1 };
    if (enqueueInput(action, { observationId: observationRef.current, hash: hashRef.current }) && doubleClick) setDoubleClickMode(false);
  };

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (![0, 1, 2].includes(event.button)) return;
    const before = displayedFrame();
    const start = before && mapScreenPoint(before.rect, before.size, event.clientX, event.clientY);
    event.currentTarget.focus();
    const control = statusRef.current?.control || inventoryRef.current?.control;
    if (needsHumanClaim(control, Date.now()) || inputSuspendedRef.current || !observationRef.current) {
      event.preventDefault();
      if (!before || !start) { void ensureHumanControl().then((ready) => { if (ready && mountedRef.current) setNotice('新しい画面を確認しました。クリック操作を続けてください。'); }); return; }
      const pending: PendingHandoffPointer = { pointerId: event.pointerId, button: event.button === 1 ? 'middle' : event.button === 2 ? 'right' : 'left', start, frame: before, ready: null, finishing: false, doubleClick: doubleClickMode };
      handoffPointerRef.current = pending;
      event.currentTarget.setPointerCapture(event.pointerId);
      void ensureHumanControl().then((ready) => { pending.ready = ready; void finishHandoffPointer(pending); });
      return;
    }
    const position = imageCoordinates(event.clientX, event.clientY);
    if (!position) return;
    event.preventDefault();
    markGuiActivity();
    event.currentTarget.setPointerCapture(event.pointerId);
    pointerRef.current = { ...position, observationId: observationRef.current, hash: hashRef.current, button: event.button === 1 ? 'middle' : event.button === 2 ? 'right' : 'left', pointerId: event.pointerId };
  };

  const handlePointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const handoff = handoffPointerRef.current;
    if (handoff && handoff.pointerId === event.pointerId) {
      handoff.end = mapScreenPoint(handoff.frame.rect, handoff.frame.size, event.clientX, event.clientY) ?? undefined;
      if (!handoff.end) handoffPointerRef.current = null;
      else void finishHandoffPointer(handoff);
      return;
    }
    const start = pointerRef.current;
    if (!start || start.pointerId !== event.pointerId) return;
    pointerRef.current = null;
    const end = imageCoordinates(event.clientX, event.clientY);
    if (!end) return;
    const moved = Math.abs(end.x - start.x) + Math.abs(end.y - start.y) > 4;
    const doubleClick = doubleClickMode && start.button === 'left' && !moved;
    const accepted = enqueueInput(moved && start.button === 'left' ? { action: 'drag', x: start.x, y: start.y, toX: end.x, toY: end.y } : { action: 'click', x: end.x, y: end.y, button: start.button, count: doubleClick ? 2 : 1 }, { observationId: start.observationId, hash: start.hash });
    if (accepted && doubleClick) setDoubleClickMode(false);
  };

  const handleWheel = (event: WheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.currentTarget.focus();
    const control = statusRef.current?.control || inventoryRef.current?.control;
    if (needsHumanClaim(control, Date.now()) || inputSuspendedRef.current || !observationRef.current) {
      void ensureHumanControl().then((ready) => { if (ready && mountedRef.current) setNotice('新しい画面を確認しました。スクロール操作を続けてください。'); });
      return;
    }
    const anchor = { observationId: observationRef.current, hash: hashRef.current };
    if (scrollAnchorRef.current && (scrollAnchorRef.current.observationId !== anchor.observationId || scrollAnchorRef.current.hash !== anchor.hash)) {
      pendingScrollRef.current = 0;
      setError('画面が更新されたため、前のスクロール操作を取り消しました。');
    }
    scrollAnchorRef.current = anchor;
    pendingScrollRef.current += event.deltaY;
    if (scrollTimeoutRef.current !== null) window.clearTimeout(scrollTimeoutRef.current);
    scrollTimeoutRef.current = window.setTimeout(() => {
      const delta = pendingScrollRef.current;
      const expected = scrollAnchorRef.current;
      pendingScrollRef.current = 0;
      scrollAnchorRef.current = null;
      scrollTimeoutRef.current = null;
      if (delta && expected) enqueueInput({ action: 'scroll', direction: delta < 0 ? 'up' : 'down', steps: Math.min(5, Math.max(1, Math.ceil(Math.abs(delta) / 100))) }, expected);
    }, SCROLL_DEBOUNCE_MS);
  };

  const handleComputerKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (document.activeElement !== frameRef.current) return;
    if (event.ctrlKey && event.shiftKey && event.key === 'Escape') {
      event.preventDefault(); clearPending(); frameRef.current?.blur(); return;
    }
    const composing = composingRef.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || (event.key === 'Enter' && Date.now() < compositionUntilRef.current);
    const action = computerKeyboardAction(event.key, event.code, { ctrl: event.ctrlKey, alt: event.altKey, shift: event.shiftKey, meta: event.metaKey }, composing);
    if (!action) return;
    event.preventDefault();
    void sendSemanticAction(action, true);
  };

  const submitText = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (composingRef.current || Date.now() < compositionUntilRef.current || !typedText) return;
    const text = typedText;
    if (new TextEncoder().encode(text).length > 10000 || text.includes('\0')) { setError('文字入力は10,000バイト以内で指定してください。'); return; }
    if (!status?.capabilities?.unicode && /[^\x00-\x7f]/.test(text)) {
      setError('この実行環境はUnicode文字入力に対応していません。日本語などの文字は送信されません。');
      return;
    }
    if (await sendSemanticAction({ action: 'type', text }) && mountedRef.current) setTypedText((current) => current === text ? '' : current);
  };

  const pasteLocalClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (mountedRef.current) {
        setTypedText((current) => current + text);
        setNotice('ローカルのクリップボードを入力欄へ貼り付けました。送信は別操作です。');
      }
    } catch { if (mountedRef.current) setError('ブラウザーからローカルのクリップボードを読み取れませんでした。'); }
  };

  const launch = (app: string) => {
    if (!inventoryRef.current?.apps.some((entry) => entry.id === app && entry.available)) return;
    const url = targetUrl.trim();
    void runServiceAction('launch', { app, ...(app === 'browser' && url ? { url } : {}) });
  };

  const registerDevelopedApp = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    let args: unknown;
    try { args = JSON.parse(developedArgs); }
    catch { setError('引数はJSON配列で指定してください。'); return; }
    if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) { setError('引数は文字列だけのJSON配列で指定してください。'); return; }
    if (!developedExecutable.trim() || !developedCwd.trim()) { setError('実行ファイルと作業ディレクトリを指定してください。'); return; }
    await scheduleRef.current(async () => {
      if (!mountedRef.current || !lifecycleRef.current || lifecycleRef.current.signal.aborted) return;
      const scopes = inventoryRef.current?.developmentScopes ?? [];
      const scope = scopes.find((entry) => entry.id === selectedScopeId) ?? (!selectedScopeId ? scopes[0] : undefined);
      if (!scope) { setError('このセッションに接続された開発アプリの作業範囲を選んでください。'); return; }
      const result = await runMutation('/api/computer/register', { scopeId: scope.id, executable: developedExecutable.trim(), args, cwd: developedCwd.trim() });
      if (result && mountedRef.current) {
        setNotice('開発アプリをこのセッションに登録しました。');
        if (lifecycleRef.current) await refreshInventory(lifecycleRef.current.signal);
      }
    });
  };

  const handleVncState = (next: VncViewState, epoch: number) => {
    if (!mountedRef.current || statusRef.current?.epoch !== epoch) return;
    vncConnectedEpochRef.current = next === 'connected' ? epoch : undefined;
    setVncViewState(next);
  };
  const handleVncActivity = () => {
    vncInputPossibleRef.current = true;
    lastStatusAtRef.current = 0;
    markGuiActivity();
  };
  const showJpegFallback = (message?: string, epoch?: number) => {
    if (!mountedRef.current || !lifecycleRef.current || lifecycleRef.current.signal.aborted) return;
    if (epoch !== undefined && epoch !== statusRef.current?.epoch) return;
    vncConnectedEpochRef.current = undefined;
    setVncViewState('disconnected');
    setJpegFallback(true);
    if (message) setError(message);
    void scheduleRef.current(() => captureScreenshot(false));
  };
  const retryVnc = () => {
    clearPending();
    clearFrame();
    vncConnectedEpochRef.current = undefined;
    setVncViewState('connecting');
    setJpegFallback(false);
    setError('');
  };

  if (status && !status.supported) return (
    <aside ref={paneRef} onBlur={handlePaneBlur} className="computer-pane" id="computer-pane" aria-label="コンピューター画面">
      <header className="computer-pane-header"><h2>コンピューター</h2><button type="button" className="computer-icon-button" onClick={() => void closePane()} aria-label="コンピューターパネルを閉じる">×</button></header>
      <div className="computer-empty-state"><span className="computer-status-dot unsupported" aria-hidden="true" /><h3>この環境では利用できません</h3><p>{status.message || 'コンピューター操作はサポートされていません。'}</p></div>
    </aside>
  );

  const control = status?.control || inventory?.control;
  const developmentScopes = inventory?.developmentScopes ?? [];
  const selectedScope = selectedScopeId ? developmentScopes.find((scope) => scope.id === selectedScopeId) : developmentScopes[0];
  return (
    <aside ref={paneRef} onBlur={handlePaneBlur} className={`computer-pane${isMaximized ? ' computer-pane-maximized' : ''}`} id="computer-pane" aria-label="コンピューター画面">
      <header className="computer-pane-header">
        <div className="computer-pane-heading"><h2>コンピューター</h2>{status && <span className={`computer-status-dot ${status.running ? 'running' : 'stopped'}`} title={status.running ? '起動中' : '停止中'} />}</div>
        <div className="computer-pane-header-actions">
          <button type="button" className="computer-icon-button" onClick={() => setIsMaximized((value) => !value)} aria-label={isMaximized ? '元のサイズに戻す' : '最大化'} title={isMaximized ? '元のサイズに戻す' : '最大化'}>□</button>
          <button type="button" className="computer-icon-button" onClick={() => { void scheduleRef.current(async () => { try { await refreshStatus(); const controller = lifecycleRef.current; if (controller && statusRef.current?.running) await refreshInventory(controller.signal); } catch (failure) { if (mountedRef.current) setError(failure instanceof Error ? failure.message : '状態を取得できませんでした。'); } }); }} aria-label="状態を更新" title="状態を更新">↻</button>
          <button type="button" className="computer-icon-button" onClick={() => void closePane()} aria-label="コンピューターパネルを閉じる">×</button>
        </div>
      </header>
      <div className="computer-pane-content">
        {error && <p className="computer-feedback error" role="alert">{error}</p>}{notice && <p className="computer-feedback" role="status">{notice}</p>}
        {!status && !error && <p className="computer-loading" role="status">状態を確認しています…</p>}
        {status?.running ? <>
          <div className="computer-control-banner">
            <span>操作権: {control?.mode === 'agent' ? 'エージェント' : control?.mode === 'human' ? '人間' : '共有'}</span>
            {control?.mine ? <button type="button" className="computer-small-button" onClick={() => void releaseGuiControl(true)} disabled={isWorking}>操作権を引き渡す</button> : <span className="computer-hint">画面やアプリを操作すると自動で取得します</span>}
          </div>
          <div className="computer-screen-toolbar">
            {jpegFallback ? <label className="computer-auto-refresh"><input type="checkbox" checked={autoRefresh} onChange={(event) => setAutoRefresh(event.target.checked)} />JPEG画面を自動更新</label>
              : <span className="computer-hint">リアルタイムVNC画面: {vncViewState === 'connected' ? '接続中' : vncViewState === 'retrying' ? '再接続中' : '接続待ち'}</span>}
            <div className="computer-screen-toolbar-actions">
              {jpegFallback ? <><button type="button" className="computer-small-button" onClick={() => void scheduleRef.current(() => captureScreenshot())} disabled={isCapturing || isWorking}>{isCapturing ? '取得中…' : 'JPEG画面を更新'}</button><button type="button" className="computer-small-button" onClick={retryVnc}>VNCへ戻す</button></>
                : <button type="button" className="computer-small-button" onClick={() => showJpegFallback()}>JPEG画面に切り替える</button>}
            </div>
          </div>
          {!jpegFallback && !authBlocked && status.epoch !== undefined
            ? <ComputerVncView key={status.epoch} epoch={status.epoch}
              onState={handleVncState} onActivity={handleVncActivity} onUnavailable={showJpegFallback} />
            : jpegFallback ? <div ref={frameRef} className="computer-screen" tabIndex={0} aria-label="JPEGコンピューター画面。フォーカスすると操作権を取得し、クリック、ドラッグ、キー入力を行えます。" onFocus={() => { markGuiActivity(); void ensureHumanControl(); }} onPointerDown={handlePointerDown} onPointerUp={handlePointerUp} onPointerCancel={() => { pointerRef.current = null; handoffPointerRef.current = null; }} onWheel={handleWheel} onKeyDown={handleComputerKey} onCompositionStart={() => { composingRef.current = true; setIsComposing(true); }} onCompositionEnd={() => { composingRef.current = false; compositionUntilRef.current = Date.now() + 50; setIsComposing(false); }} onContextMenu={(event) => event.preventDefault()}>
              {imageUrl ? <img ref={imageRef} src={imageUrl} alt="現在のコンピューター画面" draggable={false} /> : <div className="computer-screen-placeholder">{status.capture?.error || (status.capture?.ready ? 'フレームを表示しています…' : isCapturing ? '画面を取得しています…' : '利用可能なフレームがありません')}</div>}
              {isCapturing && imageUrl && <span className="computer-capture-indicator" role="status">撮影中…</span>}
            </div> : <p className="computer-hint">画面に接続できません。認証状態を確認してください。</p>}
          {queueSize > 0 && <p className="computer-queue-status" role="status">入力待ち {queueSize}/{MAX_INPUT_QUEUE}</p>}
          {jpegFallback && <div className="computer-control-row">
            <button type="button" className={`computer-small-button ${doubleClickMode ? 'active' : ''}`} onClick={() => { if (doubleClickMode) { setDoubleClickMode(false); return; } void ensureHumanControl().then((ready) => { if (ready && mountedRef.current && document.hasFocus() && paneRef.current?.contains(document.activeElement)) setDoubleClickMode(true); }); }} aria-pressed={doubleClickMode}>次のクリックをダブルクリック</button>
            <span className="computer-hint">画面にフォーカス中だけキーを送信します。Ctrl+Shift+Escで解除</span>
          </div>}
          <form className="computer-type-form" onSubmit={submitText}>
            <label htmlFor="computer-type-text">入力欄（日本語等のUnicodeは未対応）</label>
            <input id="computer-type-text" type="text" value={typedText} onChange={(event) => setTypedText(event.target.value)} onCompositionStart={() => { composingRef.current = true; setIsComposing(true); }} onCompositionEnd={() => { composingRef.current = false; compositionUntilRef.current = Date.now() + 50; setIsComposing(false); }} placeholder="文字を入力して送信" />
            <button type="button" className="computer-small-button" onClick={() => void pasteLocalClipboard()}>ローカルから貼り付け</button>
            <button type="submit" className="computer-small-button" disabled={!typedText || isComposing}>送信</button>
          </form>
          <p className="computer-observation-hint">{jpegFallback ? 'JPEG画面では各操作後に新しい画面を取得します。' : 'VNC画面は差分で更新されます。画面をクリック・入力すると操作権を取得します。'} 文字入力欄は別のJPEG観測でASCIIだけを送信します。VNCでの日本語・IME入力は未検証です。リモートクリップボード連携はありません。画面を閉じてもアプリは停止しません。</p>
          <section className="computer-app-inventory" aria-label="起動中のアプリ">
            <h3>起動中のアプリ</h3>
            {inventory?.instances.length ? inventory.instances.map((instance) => <article className="computer-app-card" key={instance.id}>
              <div className="computer-app-card-heading"><strong>{instance.label}</strong><button type="button" className="computer-small-button" onClick={() => void runServiceAction('close', { instanceId: instance.id })} disabled={isWorking}>閉じる</button></div>
              {instance.windows.length ? <div className="computer-window-list">{instance.windows.map((win) => <button type="button" key={win.id} className="computer-window-button" onClick={() => void runServiceAction('focus', { instanceId: instance.id, windowId: win.id })} disabled={isWorking} title={win.title}>{win.title || '無題のウィンドウ'}</button>)}</div> : <p className="computer-hint">プロセス起動中、ウィンドウ待ち</p>}
            </article>) : <p className="computer-hint">起動中のアプリはありません。</p>}
          </section>
          <button type="button" className="computer-stop-button" onClick={() => void runServiceAction('stop')} disabled={isWorking}>コンピューターを停止</button>
        </> : status?.supported ? <div className="computer-empty-state"><span className="computer-status-dot stopped" aria-hidden="true" /><h3>コンピューターは停止中です</h3><p>起動すると、このDeck IDEとは独立したデスクトップ環境が開きます。</p><button type="button" className="computer-primary-button" onClick={() => void runServiceAction('prepare')} disabled={isWorking || !status}>{isWorking ? '起動しています…' : 'コンピューターを起動'}</button></div> : null}
      </div>
      {status?.running && <footer className="computer-pane-footer">
        <label htmlFor="computer-browser-url">アプリカタログ</label>
        <div className="computer-launch-row">{inventory?.apps.map((app) => <button type="button" key={app.id} className="computer-small-button" onClick={() => launch(app.id)} disabled={!app.available || isWorking} title={app.reason || app.label}>{app.label}</button>)}</div>
        <div className="computer-launch-row"><input id="computer-browser-url" type="url" value={targetUrl} onChange={(event) => setTargetUrl(event.target.value)} placeholder="https://example.com" aria-label="ブラウザーURL" /></div>
        {!control?.mine && <p className="computer-hint">起動時に操作権を自動取得します。利用できないアプリはボタンの理由を確認してください。</p>}
        {status.capabilities?.developedApps ? <>
          <button type="button" className="computer-small-button computer-developed-toggle" onClick={() => setShowDevelopedApp((shown) => !shown)} aria-expanded={showDevelopedApp}>開発アプリをこのセッションに登録 {showDevelopedApp ? '−' : '+'}</button>
          {showDevelopedApp && <form className="computer-developed-form" onSubmit={(event) => void registerDevelopedApp(event)}>
            <label htmlFor="computer-dev-scope">接続済みの作業範囲</label><select id="computer-dev-scope" value={selectedScope?.id ?? ''} onChange={(event) => setSelectedScopeId(event.target.value)} disabled={!developmentScopes.length}>{!selectedScope && <option value="" disabled>作業範囲を選択</option>}{developmentScopes.map((scope) => <option key={scope.id} value={scope.id}>{scope.root} ({scope.id})</option>)}</select>
            {!developmentScopes.length && <p className="computer-hint">作業範囲を取得できませんでした。状態を更新してください。</p>}
            <label htmlFor="computer-dev-executable">実行ファイル（選択した範囲内の相対パス、または絶対パス）</label><input id="computer-dev-executable" value={developedExecutable} onChange={(event) => setDevelopedExecutable(event.target.value)} placeholder="build/my-app" />
            <label htmlFor="computer-dev-args">引数（JSON文字列配列）</label><textarea id="computer-dev-args" value={developedArgs} onChange={(event) => setDevelopedArgs(event.target.value)} rows={2} spellCheck={false} />
            <label htmlFor="computer-dev-cwd">作業ディレクトリ（選択した範囲内）</label><input id="computer-dev-cwd" value={developedCwd} onChange={(event) => setDevelopedCwd(event.target.value)} placeholder="." />
            <p className="computer-hint">登録内容はこのセッションだけに保持されます。登録後の起動には操作権が必要です。</p>
            <button type="submit" className="computer-small-button" disabled={!selectedScope || isWorking}>登録</button>
          </form>}
        </> : <p className="computer-hint">このセッションには開発アプリ用の作業範囲が接続されていません。</p>}
      </footer>}
    </aside>
  );
}
