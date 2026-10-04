import { useEffect, useRef, useState, type FocusEvent, type KeyboardEvent, type PointerEvent, type WheelEvent } from 'react';
import type RFB from '@novnc/novnc';
import { apiJson } from '../api';
import { API_BASE } from '../constants';
import { computerVncSocketUrl } from './computer-helpers';

type VncCredentials = { password: string; epoch: number; width: number; height: number };
type VncTicket = { token: string };
export type VncViewState = 'connecting' | 'connected' | 'retrying' | 'paused' | 'disconnected';

interface ComputerVncViewProps {
  epoch: number;
  onState: (state: VncViewState, epoch: number) => void;
  onActivity: () => void;
  onUnavailable: (message: string, epoch: number) => void;
}

const MAX_ATTEMPTS = 3;
const HANDSHAKE_MS = 8000;
const VNC_WIDTH = 1280;
const VNC_HEIGHT = 720;

export function ComputerVncView({ epoch, onState, onActivity, onUnavailable }: ComputerVncViewProps) {
  const targetRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const rfbRef = useRef<RFB | null>(null);
  const focusedRef = useRef(false);
  const connectedRef = useRef(false);
  const callbacksRef = useRef({ onState, onActivity, onUnavailable });
  const [state, setState] = useState<VncViewState>('connecting');
  callbacksRef.current = { onState, onActivity, onUnavailable };

  useEffect(() => {
    let disposed = false;
    let serial = 0;
    let attempts = 0;
    let retryTimer: number | null = null;
    let handshakeTimer: number | null = null;
    let request: AbortController | null = null;

    const report = (next: VncViewState) => {
      if (disposed) return;
      setState(next);
      callbacksRef.current.onState(next, epoch);
    };
    const clearTimers = () => {
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      if (handshakeTimer !== null) window.clearTimeout(handshakeTimer);
      retryTimer = null;
      handshakeTimer = null;
    };
    const disconnect = () => {
      const current = rfbRef.current;
      rfbRef.current = null;
      connectedRef.current = false;
      focusedRef.current = false;
      if (current) {
        current.viewOnly = true;
        current.blur();
        current.disconnect();
      }
      targetRef.current?.replaceChildren();
    };
    const fail = (attempt: number, message: string) => {
      if (disposed || serial !== attempt) return;
      serial++;
      request?.abort();
      clearTimers();
      disconnect();
      if (document.visibilityState !== 'visible') { report('paused'); return; }
      if (attempts >= MAX_ATTEMPTS) {
        report('disconnected');
        callbacksRef.current.onUnavailable(`${message} JPEG画面表示に切り替えました。`, epoch);
        return;
      }
      report('retrying');
      retryTimer = window.setTimeout(() => { retryTimer = null; void connect(); }, 500 * (2 ** (attempts - 1)));
    };
    const connect = async () => {
      if (disposed || document.visibilityState !== 'visible' || !targetRef.current) return;
      clearTimers();
      disconnect();
      attempts++;
      const attempt = ++serial;
      request = new AbortController();
      report('connecting');
      handshakeTimer = window.setTimeout(() => fail(attempt, 'VNC接続がタイムアウトしました。'), HANDSHAKE_MS);
      try {
        const credentials = await apiJson<VncCredentials>('/api/computer/vnc', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: request.signal,
        });
        if (disposed || serial !== attempt || document.visibilityState !== 'visible') return;
        if (!credentials.password || credentials.epoch !== epoch || credentials.width !== VNC_WIDTH || credentials.height !== VNC_HEIGHT)
          throw new Error('コンピューターの世代または画面サイズが変わりました。');
        const ticket = await apiJson<VncTicket>('/api/computer/vnc-ticket', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ epoch }), signal: request.signal,
        });
        if (disposed || serial !== attempt || document.visibilityState !== 'visible') return;
        const socketUrl = computerVncSocketUrl(API_BASE, window.location.origin, ticket.token, epoch);
        const RFBClass = (await import('@novnc/novnc')).default;
        if (disposed || serial !== attempt || document.visibilityState !== 'visible' || !targetRef.current) return;
        const rfb = new RFBClass(targetRef.current, socketUrl, { credentials: { password: credentials.password } });
        rfbRef.current = rfb;
        rfb.viewOnly = true;
        rfb.scaleViewport = true;
        rfb.resizeSession = false;
        rfb.addEventListener('credentialsrequired', () => rfb.sendCredentials({ password: credentials.password }));
        rfb.addEventListener('connect', () => {
          if (disposed || serial !== attempt || rfbRef.current !== rfb) return;
          if (handshakeTimer !== null) window.clearTimeout(handshakeTimer);
          handshakeTimer = null;
          connectedRef.current = true;
          rfb.viewOnly = !focusedRef.current || document.visibilityState !== 'visible';
          if (focusedRef.current) rfb.focus();
          report('connected');
        });
        rfb.addEventListener('disconnect', () => {
          if (rfbRef.current === rfb) fail(attempt, 'VNC接続が切れました。');
        });
        rfb.addEventListener('securityfailure', () => fail(attempt, 'VNC認証に失敗しました。'));
      } catch (failure: unknown) {
        if (disposed || serial !== attempt || request.signal.aborted) return;
        fail(attempt, failure instanceof Error ? failure.message : 'VNC接続に失敗しました。');
      }
    };
    const visibility = () => {
      if (document.visibilityState !== 'visible') {
        serial++;
        request?.abort();
        clearTimers();
        disconnect();
        report('paused');
      } else if (!disposed) {
        attempts = 0;
        void connect();
      }
    };
    document.addEventListener('visibilitychange', visibility);
    if (document.visibilityState === 'visible') void connect();
    else report('paused');
    return () => {
      disposed = true;
      serial++;
      request?.abort();
      clearTimers();
      disconnect();
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [epoch]);

  const focus = () => {
    focusedRef.current = true;
    if (connectedRef.current && rfbRef.current) {
      rfbRef.current.viewOnly = false;
      rfbRef.current.focus();
    }
  };
  const blur = (event: FocusEvent<HTMLDivElement>) => {
    if (event.relatedTarget instanceof Node && frameRef.current?.contains(event.relatedTarget)) return;
    focusedRef.current = false;
    if (rfbRef.current) { rfbRef.current.viewOnly = true; rfbRef.current.blur(); }
  };
  const activeInput = () => {
    if (connectedRef.current && focusedRef.current) callbacksRef.current.onActivity();
  };
  const pointerDown = (event: PointerEvent<HTMLDivElement>) => {
    frameRef.current?.focus();
    focus();
    if (!connectedRef.current) { event.preventDefault(); event.stopPropagation(); return; }
    activeInput();
  };
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!connectedRef.current || !focusedRef.current) { event.preventDefault(); event.stopPropagation(); return; }
    activeInput();
  };
  const wheel = (event: WheelEvent<HTMLDivElement>) => {
    frameRef.current?.focus();
    focus();
    if (!connectedRef.current) { event.preventDefault(); event.stopPropagation(); return; }
    activeInput();
  };

  return <div ref={frameRef} className="computer-vnc-screen" tabIndex={0}
    aria-label="リアルタイムのコンピューター画面。フォーカス中のクリックとキー入力だけを送信します。"
    onFocusCapture={focus} onBlurCapture={blur} onPointerDownCapture={pointerDown}
    onPointerMoveCapture={(event) => { if (event.buttons) activeInput(); }}
    onKeyDownCapture={keyDown} onWheelCapture={wheel} onContextMenu={(event) => event.preventDefault()}>
    <div ref={targetRef} className="computer-vnc-target" />
    {state !== 'connected' && <div className="computer-vnc-overlay" role="status">
      {state === 'paused' ? '画面が非表示のため接続を休止しています。' : state === 'retrying' ? 'VNC接続を再試行しています…' : 'リアルタイム画面に接続しています…'}
    </div>}
  </div>;
}
