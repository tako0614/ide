import { useCallback, useEffect, useRef, useState } from 'react';
import type { BrowserAudioStatus, BrowserStatus, BrowserTab } from '../types';
import {
  getBrowserStatus,
  getWsToken,
  navigateBrowser,
  startBrowser,
  stopBrowser
} from '../api';

// Frames now arrive as binary WebSocket messages (raw JPEG); only control
// messages are JSON.
type BrowserServerMessage =
  | { type: 'status'; status: BrowserStatus }
  | { type: 'clear' }
  | { type: 'error'; error: string };

type BrowserAudioServerMessage =
  | { type: 'audio-status'; status: BrowserAudioStatus }
  | { type: 'audio-error'; error: string };

type BrowserClientMessage =
  | { type: 'resize'; width: number; height: number }
  | { type: 'navigate'; url: string }
  | { type: 'back' }
  | { type: 'forward' }
  | { type: 'reload' }
  | { type: 'new-tab'; url?: string }
  | { type: 'close-tab'; targetId: string }
  | { type: 'activate-tab'; targetId: string }
  | {
      type: 'mouse';
      eventType: 'mouseMoved' | 'mousePressed' | 'mouseReleased' | 'mouseWheel';
      x: number;
      y: number;
      button?: 'none' | 'left' | 'middle' | 'right';
      clickCount?: number;
      deltaX?: number;
      deltaY?: number;
      modifiers?: number;
    }
  | {
      type: 'key';
      eventType: 'keyDown' | 'keyUp';
      key: string;
      code: string;
      text?: string;
      modifiers?: number;
    };

interface BrowserPaneProps {
  wsBase: string;
}

const AUDIO_MIME_TYPE = 'audio/webm; codecs="opus"';
const AUDIO_QUEUE_LIMIT = 64;

function getKeyModifiers(event: KeyboardEvent | React.KeyboardEvent): number {
  let modifiers = 0;
  if (event.altKey) modifiers |= 1;
  if (event.ctrlKey) modifiers |= 2;
  if (event.metaKey) modifiers |= 4;
  if (event.shiftKey) modifiers |= 8;
  return modifiers;
}

function getMouseModifiers(event: MouseEvent | React.MouseEvent | WheelEvent | React.WheelEvent): number {
  let modifiers = 0;
  if (event.altKey) modifiers |= 1;
  if (event.ctrlKey) modifiers |= 2;
  if (event.metaKey) modifiers |= 4;
  if (event.shiftKey) modifiers |= 8;
  return modifiers;
}

function pointerButton(button: number): 'none' | 'left' | 'middle' | 'right' {
  if (button === 0) return 'left';
  if (button === 1) return 'middle';
  if (button === 2) return 'right';
  return 'none';
}

function isTextEntryTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement
    || target instanceof HTMLTextAreaElement
    || target instanceof HTMLSelectElement
    || (target instanceof HTMLElement && target.isContentEditable);
}

// about:blank is the engine's idle page; treat it as "no page" so it never
// shows up in the address bar or counts as real content.
function isBlankPage(url: string | null | undefined): boolean {
  return !url || url === 'about:blank';
}

function displayUrl(url: string | null | undefined): string | null {
  return isBlankPage(url) ? null : (url as string);
}

// Short, human label for a tab: page title, else hostname, else a placeholder.
function tabLabel(tab: BrowserTab): string {
  if (tab.title.trim()) {
    return tab.title.trim();
  }
  if (tab.url && !isBlankPage(tab.url)) {
    try {
      return new URL(tab.url).hostname || tab.url;
    } catch {
      return tab.url;
    }
  }
  return '新しいタブ';
}

// Non-trickle ICE on the client side: resolve once host candidates are gathered
// (instant for same-host / LAN), then send a complete offer.
function waitIceGathering(pc: RTCPeerConnection, timeoutMs = 2000): Promise<void> {
  if (pc.iceGatheringState === 'complete') {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    const done = () => {
      pc.removeEventListener('icegatheringstatechange', check);
      resolve();
    };
    const check = () => {
      if (pc.iceGatheringState === 'complete') done();
    };
    pc.addEventListener('icegatheringstatechange', check);
    setTimeout(done, timeoutMs);
  });
}

// M1 opt-in: WebRTC video path is only attempted when the page is loaded with
// ?webrtc=1. Later milestones promote this to capability-driven auto-selection.
function webrtcOptIn(): boolean {
  try {
    return new URLSearchParams(window.location.search).get('webrtc') === '1';
  } catch {
    return false;
  }
}

export function BrowserPane({ wsBase }: BrowserPaneProps) {
  const socketRef = useRef<WebSocket | null>(null);
  const audioSocketRef = useRef<WebSocket | null>(null);
  const webrtcSocketRef = useRef<WebSocket | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);
  // Pixel dimensions of the most recently drawn frame, used to map client
  // coordinates into the page's coordinate space.
  const frameSizeRef = useRef({ width: 0, height: 0 });
  // Guards against decoding a new frame while the previous one is still being
  // decoded — we coalesce to the latest frame to stay real-time instead of
  // queuing. pendingFrameRef holds the newest undecoded frame.
  const decodingRef = useRef(false);
  const pendingFrameRef = useRef<ArrayBuffer | null>(null);
  const hasFrameRef = useRef(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const mediaSourceRef = useRef<MediaSource | null>(null);
  const sourceBufferRef = useRef<SourceBuffer | null>(null);
  const audioUrlRef = useRef<string | null>(null);
  const audioQueueRef = useRef<ArrayBuffer[]>([]);
  const lastSizeRef = useRef({ width: 0, height: 0 });
  const pointerDownRef = useRef(false);
  const pressedButtonRef = useRef<'none' | 'left' | 'middle' | 'right'>('none');
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptsRef = useRef(0);
  // Tracks which tab the address bar/canvas currently reflect, so a tab switch
  // can refresh the address even when navigating to a blank page.
  const activeTabIdRef = useRef<string | null>(null);
  // Safety timer that drops the tab-switch spinner if the new tab never paints
  // a frame (e.g. about:blank may not emit one).
  const switchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [status, setStatus] = useState<BrowserStatus | null>(null);
  const [address, setAddress] = useState('');
  // Only a coarse "do we have a real frame on the canvas" flag — the actual
  // pixels are drawn imperatively so frames never trigger a React re-render.
  const [hasFrame, setHasFrame] = useState(false);
  // True from a tab switch until the new tab's first frame arrives, so we show a
  // spinner instead of the stale page or the "ready" placeholder.
  const [switching, setSwitching] = useState(false);
  const [connected, setConnected] = useState(false);
  // True once a WebRTC video track is rendering; suppresses the JPEG canvas.
  const [webrtcActive, setWebrtcActive] = useState(false);
  const [audioEnabled, setAudioEnabled] = useState(false);
  const [audioStatus, setAudioStatus] = useState<BrowserAudioStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [audioError, setAudioError] = useState<string | null>(null);

  const send = useCallback((message: BrowserClientMessage) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }
    socket.send(JSON.stringify(message));
  }, []);

  const sendCurrentSize = useCallback(() => {
    const { width, height } = lastSizeRef.current;
    if (width > 0 && height > 0) {
      send({ type: 'resize', width, height });
    }
  }, [send]);

  const clearFrame = useCallback(() => {
    hasFrameRef.current = false;
    frameSizeRef.current = { width: 0, height: 0 };
    pendingFrameRef.current = null;
    setHasFrame(false);
    const canvas = canvasRef.current;
    if (canvas && ctxRef.current) {
      ctxRef.current.clearRect(0, 0, canvas.width, canvas.height);
    }
  }, []);

  const drawFrame = useCallback((data: ArrayBuffer) => {
    // Always keep the newest frame; if a decode is already running it will pick
    // this one up when it finishes. We coalesce to the latest frame (never build
    // a backlog) but never lose the trailing frame, so motion ends on the
    // correct image instead of a stale one.
    pendingFrameRef.current = data;
    if (decodingRef.current) {
      return;
    }

    const pump = () => {
      const next = pendingFrameRef.current;
      if (next === null) {
        return;
      }
      pendingFrameRef.current = null;
      decodingRef.current = true;
      createImageBitmap(new Blob([next], { type: 'image/jpeg' }))
        .then((bitmap) => {
          const canvas = canvasRef.current;
          if (!canvas) {
            bitmap.close();
            return;
          }
          if (!ctxRef.current) {
            ctxRef.current = canvas.getContext('2d');
          }
          const ctx = ctxRef.current;
          if (!ctx) {
            bitmap.close();
            return;
          }
          if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
            canvas.width = bitmap.width;
            canvas.height = bitmap.height;
          }
          frameSizeRef.current = { width: bitmap.width, height: bitmap.height };
          ctx.drawImage(bitmap, 0, 0);
          bitmap.close();
          if (!hasFrameRef.current) {
            hasFrameRef.current = true;
            setHasFrame(true);
          }
          // The new tab painted — drop the switch spinner.
          if (switchTimerRef.current) {
            clearTimeout(switchTimerRef.current);
            switchTimerRef.current = null;
          }
          setSwitching(false);
        })
        .catch(() => undefined)
        .finally(() => {
          decodingRef.current = false;
          if (pendingFrameRef.current !== null) {
            pump();
          }
        });
    };
    pump();
  }, []);

  useEffect(() => {
    let alive = true;
    getBrowserStatus()
      .then((next) => {
        if (!alive) return;
        setStatus(next);
        setAudioStatus(next.audio);
        activeTabIdRef.current = next.activeTabId;
        const url = displayUrl(next.pageUrl);
        if (url) {
          setAddress(url);
        }
        if (next.error) {
          setError(next.error);
        }
      })
      .catch((err: unknown) => {
        if (alive) {
          setError(err instanceof Error ? err.message : 'Browser status failed');
        }
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;

    const observer = new ResizeObserver(([entry]) => {
      const width = Math.floor(entry.contentRect.width);
      const height = Math.floor(entry.contentRect.height);
      if (width <= 0 || height <= 0) return;
      if (lastSizeRef.current.width === width && lastSizeRef.current.height === height) {
        return;
      }
      lastSizeRef.current = { width, height };
      send({ type: 'resize', width, height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [send]);

  useEffect(() => {
    let cancelled = false;

    const clearReconnectTimer = () => {
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
    };

    const connect = async () => {
      if (cancelled) return;
      clearReconnectTimer();

      try {
        const { token, authEnabled } = await getWsToken();
        if (cancelled) return;

        const baseUrl = `${wsBase}/api/browser/ws`;
        const url = authEnabled ? `${baseUrl}?token=${encodeURIComponent(token)}` : baseUrl;
        const socket = new WebSocket(url);
        socket.binaryType = 'arraybuffer';
        socketRef.current = socket;

        socket.addEventListener('open', () => {
          reconnectAttemptsRef.current = 0;
          setConnected(true);
          setError(null);
          sendCurrentSize();
        });

        socket.addEventListener('message', (event) => {
          // Binary messages are raw JPEG screencast frames.
          if (event.data instanceof ArrayBuffer) {
            drawFrame(event.data);
            return;
          }
          if (typeof event.data !== 'string') {
            return;
          }
          let message: BrowserServerMessage;
          try {
            message = JSON.parse(event.data) as BrowserServerMessage;
          } catch {
            return;
          }

          if (message.type === 'clear') {
            // The active tab changed (or closed); show the spinner until the new
            // tab paints, with a safety timeout for pages that never emit a frame.
            clearFrame();
            setSwitching(true);
            if (switchTimerRef.current) {
              clearTimeout(switchTimerRef.current);
            }
            switchTimerRef.current = setTimeout(() => {
              switchTimerRef.current = null;
              setSwitching(false);
            }, 2500);
            return;
          }

          if (message.type === 'status') {
            const next = message.status;
            setStatus(next);
            setAudioStatus(next.audio);
            if (next.activeTabId !== activeTabIdRef.current) {
              // Switched tabs — reflect the new tab's URL even if it is blank.
              activeTabIdRef.current = next.activeTabId;
              const activeTab = next.tabs.find((tab) => tab.id === next.activeTabId);
              setAddress(displayUrl(activeTab?.url) ?? '');
            } else {
              const url = displayUrl(next.pageUrl);
              if (url) {
                setAddress(url);
              }
            }
            if (next.error) {
              setError(next.error);
            }
            return;
          }

          if (message.type === 'error') {
            setError(message.error);
          }
        });

        socket.addEventListener('close', () => {
          if (socketRef.current === socket) {
            socketRef.current = null;
          }
          setConnected(false);
          if (cancelled) {
            return;
          }
          const attempt = Math.min(reconnectAttemptsRef.current + 1, 6);
          reconnectAttemptsRef.current = attempt;
          reconnectTimerRef.current = setTimeout(connect, 500 * Math.pow(2, attempt - 1));
        });

        socket.addEventListener('error', () => {
          setConnected(false);
        });
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Browser connection failed');
        const attempt = Math.min(reconnectAttemptsRef.current + 1, 6);
        reconnectAttemptsRef.current = attempt;
        reconnectTimerRef.current = setTimeout(connect, 500 * Math.pow(2, attempt - 1));
      }
    };

    connect();

    return () => {
      cancelled = true;
      clearReconnectTimer();
      if (socketRef.current) {
        socketRef.current.close();
        socketRef.current = null;
      }
    };
  }, [clearFrame, drawFrame, sendCurrentSize, wsBase]);

  useEffect(() => {
    return () => {
      if (switchTimerRef.current) {
        clearTimeout(switchTimerRef.current);
        switchTimerRef.current = null;
      }
    };
  }, []);

  // WebRTC video path (A1). Independent of the JPEG control WS: it opens its own
  // authed signaling socket, negotiates a recvonly video peer connection, and
  // renders the stream into <video>. Gated behind ?webrtc=1 for the M1 gate.
  useEffect(() => {
    if (!webrtcOptIn()) {
      return;
    }
    let cancelled = false;
    let pc: RTCPeerConnection | null = null;
    let socket: WebSocket | null = null;

    const teardown = () => {
      if (pc) {
        try { pc.close(); } catch { /* ignore */ }
        pc = null;
      }
      if (socket) {
        try { socket.close(); } catch { /* ignore */ }
        socket = null;
      }
      pcRef.current = null;
      webrtcSocketRef.current = null;
      setWebrtcActive(false);
    };

    const connect = async () => {
      try {
        const { token, authEnabled } = await getWsToken();
        if (cancelled) return;
        const base = `${wsBase}/api/browser/webrtc/ws`;
        const url = authEnabled ? `${base}?token=${encodeURIComponent(token)}` : base;
        socket = new WebSocket(url);
        webrtcSocketRef.current = socket;

        socket.addEventListener('open', async () => {
          if (cancelled || !socket) return;
          pc = new RTCPeerConnection({ iceServers: [] });
          pcRef.current = pc;
          pc.addTransceiver('video', { direction: 'recvonly' });

          pc.ontrack = (event) => {
            const [stream] = event.streams;
            const video = videoRef.current;
            if (video && stream) {
              video.srcObject = stream;
              video.play().catch(() => undefined);
              setWebrtcActive(true);
            }
          };
          pc.onconnectionstatechange = () => {
            const state = pc?.connectionState;
            if (state === 'failed' || state === 'disconnected' || state === 'closed') {
              setWebrtcActive(false);
            }
          };

          try {
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            await waitIceGathering(pc);
            if (cancelled || !socket || socket.readyState !== WebSocket.OPEN) return;
            socket.send(JSON.stringify({ type: 'webrtc-offer', sdp: pc.localDescription?.sdp }));
          } catch (err) {
            if (!cancelled) {
              setError(err instanceof Error ? err.message : 'WebRTC negotiation failed');
            }
          }
        });

        socket.addEventListener('message', async (event) => {
          if (typeof event.data !== 'string') return;
          let message: { type?: string; sdp?: string; error?: string };
          try {
            message = JSON.parse(event.data);
          } catch {
            return;
          }
          if (message.type === 'webrtc-answer' && message.sdp && pc) {
            await pc
              .setRemoteDescription({ type: 'answer', sdp: message.sdp })
              .catch((err: unknown) => {
                if (!cancelled) setError(err instanceof Error ? err.message : 'setRemoteDescription failed');
              });
          } else if (message.type === 'webrtc-error' && message.error) {
            setError(message.error);
          }
        });

        socket.addEventListener('close', () => {
          setWebrtcActive(false);
        });
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'WebRTC connection failed');
        }
      }
    };

    void connect();
    return () => {
      cancelled = true;
      teardown();
    };
  }, [wsBase]);

  const flushAudioQueue = useCallback(() => {
    const sourceBuffer = sourceBufferRef.current;
    if (!sourceBuffer || sourceBuffer.updating) {
      return;
    }

    const next = audioQueueRef.current.shift();
    if (!next) {
      return;
    }

    try {
      sourceBuffer.appendBuffer(next);
    } catch (err) {
      audioQueueRef.current.unshift(next);
      setAudioError(err instanceof Error ? err.message : 'Browser audio append failed');
    }
  }, []);

  const appendAudioChunk = useCallback((chunk: ArrayBuffer) => {
    const copy = chunk.slice(0);
    const sourceBuffer = sourceBufferRef.current;
    if (!sourceBuffer || sourceBuffer.updating || audioQueueRef.current.length > 0) {
      if (audioQueueRef.current.length < AUDIO_QUEUE_LIMIT) {
        audioQueueRef.current.push(copy);
      }
      return;
    }

    try {
      sourceBuffer.appendBuffer(copy);
    } catch (err) {
      setAudioError(err instanceof Error ? err.message : 'Browser audio append failed');
    }
  }, []);

  const stopAudioStream = useCallback(() => {
    const socket = audioSocketRef.current;
    audioSocketRef.current = null;
    if (socket && socket.readyState !== WebSocket.CLOSED && socket.readyState !== WebSocket.CLOSING) {
      socket.close();
    }

    audioQueueRef.current = [];
    sourceBufferRef.current = null;
    const mediaSource = mediaSourceRef.current;
    mediaSourceRef.current = null;
    if (mediaSource?.readyState === 'open') {
      try {
        mediaSource.endOfStream();
      } catch {
        // ignore
      }
    }

    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
    }

    if (audioUrlRef.current) {
      URL.revokeObjectURL(audioUrlRef.current);
      audioUrlRef.current = null;
    }
    setAudioEnabled(false);
  }, []);

  const startAudioStream = useCallback(async () => {
    if (audioSocketRef.current?.readyState === WebSocket.OPEN) {
      return;
    }

    const mimeType = audioStatus?.mimeType || AUDIO_MIME_TYPE;
    if (typeof MediaSource === 'undefined' || !MediaSource.isTypeSupported(mimeType)) {
      setAudioError(`This browser cannot play ${mimeType}`);
      setAudioEnabled(false);
      return;
    }

    stopAudioStream();
    setAudioError(null);
    setAudioEnabled(true);

    const mediaSource = new MediaSource();
    mediaSourceRef.current = mediaSource;
    const objectUrl = URL.createObjectURL(mediaSource);
    audioUrlRef.current = objectUrl;

    const audio = audioRef.current;
    if (audio) {
      audio.src = objectUrl;
      audio.autoplay = true;
      audio.play().catch(() => undefined);
    }

    mediaSource.addEventListener('sourceopen', () => {
      if (mediaSourceRef.current !== mediaSource) {
        return;
      }
      try {
        const sourceBuffer = mediaSource.addSourceBuffer(mimeType);
        sourceBuffer.mode = 'sequence';
        sourceBufferRef.current = sourceBuffer;
        sourceBuffer.addEventListener('updateend', flushAudioQueue);
        flushAudioQueue();
      } catch (err) {
        setAudioError(err instanceof Error ? err.message : 'Browser audio setup failed');
        setAudioEnabled(false);
      }
    }, { once: true });

    try {
      const { token, authEnabled } = await getWsToken();
      const baseUrl = `${wsBase}/api/browser/audio/ws`;
      const url = authEnabled ? `${baseUrl}?token=${encodeURIComponent(token)}` : baseUrl;
      const socket = new WebSocket(url);
      socket.binaryType = 'arraybuffer';
      audioSocketRef.current = socket;

      socket.addEventListener('message', (event) => {
        if (typeof event.data === 'string') {
          let message: BrowserAudioServerMessage;
          try {
            message = JSON.parse(event.data) as BrowserAudioServerMessage;
          } catch {
            return;
          }

          if (message.type === 'audio-status') {
            setAudioStatus(message.status);
            if (message.status.error) {
              setAudioError(message.status.error);
            } else if (message.status.available) {
              setAudioError(null);
            }
            return;
          }

          if (message.type === 'audio-error') {
            setAudioError(message.error);
            setAudioEnabled(false);
          }
          return;
        }

        if (event.data instanceof ArrayBuffer) {
          appendAudioChunk(event.data);
          audioRef.current?.play().catch(() => undefined);
        }
      });

      socket.addEventListener('close', () => {
        if (audioSocketRef.current === socket) {
          audioSocketRef.current = null;
        }
        setAudioEnabled(false);
      });

      socket.addEventListener('error', () => {
        setAudioError('Browser audio connection failed');
        setAudioEnabled(false);
      });
    } catch (err) {
      stopAudioStream();
      setAudioError(err instanceof Error ? err.message : 'Browser audio failed');
    }
  }, [appendAudioChunk, audioStatus, flushAudioQueue, stopAudioStream, wsBase]);

  useEffect(() => {
    return () => stopAudioStream();
  }, [stopAudioStream]);

  const handleToggleAudio = useCallback(() => {
    if (audioEnabled || audioSocketRef.current) {
      stopAudioStream();
      return;
    }
    void startAudioStream();
  }, [audioEnabled, startAudioStream, stopAudioStream]);

  const handleStart = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await startBrowser();
      setStatus(next);
      setAudioStatus(next.audio);
      const url = displayUrl(next.pageUrl);
      if (url) {
        setAddress(url);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Browser start failed');
    } finally {
      setBusy(false);
    }
  }, []);

  const handleStop = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await stopBrowser();
      setStatus(next);
      setAudioStatus(next.audio);
      clearFrame();
      stopAudioStream();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Browser stop failed');
    } finally {
      setBusy(false);
    }
  }, [clearFrame, stopAudioStream]);

  const handleNavigate = useCallback(async () => {
    const url = address.trim();
    if (!url) return;
    setBusy(true);
    setError(null);
    try {
      const next = await navigateBrowser(url);
      setStatus(next);
      setAudioStatus(next.audio);
      const shown = displayUrl(next.pageUrl);
      if (shown) {
        setAddress(shown);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Navigate failed');
    } finally {
      setBusy(false);
    }
  }, [address]);

  const handleNewTab = useCallback(() => {
    send({ type: 'new-tab' });
  }, [send]);

  const handleActivateTab = useCallback((targetId: string) => {
    if (targetId === activeTabIdRef.current) return;
    send({ type: 'activate-tab', targetId });
  }, [send]);

  const handleCloseTab = useCallback((targetId: string) => {
    send({ type: 'close-tab', targetId });
  }, [send]);

  const getBrowserPointFromClient = useCallback((clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return null;
    }
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return null;
    }

    const width = frameSizeRef.current.width || canvas.width || lastSizeRef.current.width || 1280;
    const height = frameSizeRef.current.height || canvas.height || lastSizeRef.current.height || 720;
    // The canvas fills the viewport but renders the frame with
    // `object-fit: contain`, so the visible image is letterboxed inside the
    // element box. Map against that contained rect, not the full element, or
    // clicks drift by the letterbox offset.
    const scale = Math.min(rect.width / width, rect.height / height);
    const displayWidth = width * scale;
    const displayHeight = height * scale;
    const offsetX = rect.left + (rect.width - displayWidth) / 2;
    const offsetY = rect.top + (rect.height - displayHeight) / 2;
    const x = Math.max(0, Math.min(width, ((clientX - offsetX) / displayWidth) * width));
    const y = Math.max(0, Math.min(height, ((clientY - offsetY) / displayHeight) * height));
    return { x, y };
  }, []);

  const getBrowserPoint = useCallback((event: React.MouseEvent | React.WheelEvent) => {
    return getBrowserPointFromClient(event.clientX, event.clientY);
  }, [getBrowserPointFromClient]);

  const handleMouseMove = useCallback((event: React.MouseEvent) => {
    const point = getBrowserPoint(event);
    if (!point) return;
    send({
      type: 'mouse',
      eventType: 'mouseMoved',
      x: point.x,
      y: point.y,
      button: pointerDownRef.current ? pressedButtonRef.current : 'none',
      modifiers: getMouseModifiers(event),
    });
  }, [getBrowserPoint, send]);

  const handleMouseDown = useCallback((event: React.MouseEvent) => {
    const point = getBrowserPoint(event);
    if (!point) return;
    event.preventDefault();
    viewportRef.current?.focus({ preventScroll: true });
    pointerDownRef.current = true;
    pressedButtonRef.current = pointerButton(event.button);
    send({
      type: 'mouse',
      eventType: 'mousePressed',
      x: point.x,
      y: point.y,
      button: pressedButtonRef.current,
      clickCount: event.detail || 1,
      modifiers: getMouseModifiers(event),
    });
  }, [getBrowserPoint, send]);

  const handleMouseUp = useCallback((event: React.MouseEvent) => {
    const point = getBrowserPoint(event);
    if (!point) return;
    event.preventDefault();
    const button = pressedButtonRef.current;
    pointerDownRef.current = false;
    pressedButtonRef.current = 'none';
    send({
      type: 'mouse',
      eventType: 'mouseReleased',
      x: point.x,
      y: point.y,
      button,
      clickCount: event.detail || 1,
      modifiers: getMouseModifiers(event),
    });
  }, [getBrowserPoint, send]);

  useEffect(() => {
    const handleGlobalMouseUp = (event: MouseEvent) => {
      if (!pointerDownRef.current) {
        return;
      }
      const point = getBrowserPointFromClient(event.clientX, event.clientY);
      const button = pressedButtonRef.current;
      pointerDownRef.current = false;
      pressedButtonRef.current = 'none';
      if (!point) {
        return;
      }
      send({
        type: 'mouse',
        eventType: 'mouseReleased',
        x: point.x,
        y: point.y,
        button,
        clickCount: 1,
        modifiers: getMouseModifiers(event),
      });
    };

    window.addEventListener('mouseup', handleGlobalMouseUp);
    return () => window.removeEventListener('mouseup', handleGlobalMouseUp);
  }, [getBrowserPointFromClient, send]);

  const handleWheel = useCallback((event: React.WheelEvent) => {
    const point = getBrowserPoint(event);
    if (!point) return;
    event.preventDefault();
    send({
      type: 'mouse',
      eventType: 'mouseWheel',
      x: point.x,
      y: point.y,
      button: 'none',
      deltaX: event.deltaX,
      deltaY: event.deltaY,
      modifiers: getMouseModifiers(event),
    });
  }, [getBrowserPoint, send]);

  const handleKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (isTextEntryTarget(event.target)) {
      return;
    }
    event.preventDefault();
    const text = !event.ctrlKey && !event.metaKey && !event.altKey && event.key.length === 1
      ? event.key
      : undefined;
    send({
      type: 'key',
      eventType: 'keyDown',
      key: event.key,
      code: event.code,
      text,
      modifiers: getKeyModifiers(event),
    });
  }, [send]);

  const handleKeyUp = useCallback((event: React.KeyboardEvent) => {
    if (isTextEntryTarget(event.target)) {
      return;
    }
    event.preventDefault();
    send({
      type: 'key',
      eventType: 'keyUp',
      key: event.key,
      code: event.code,
      modifiers: getKeyModifiers(event),
    });
  }, [send]);

  const audioButtonTitle = audioStatus?.reason
    || audioError
    || (audioEnabled ? 'Stop audio' : 'Start audio');

  const running = status?.running ?? false;
  const launching = status?.launching ?? false;
  const tabs = status?.tabs ?? [];
  const activeTabId = status?.activeTabId ?? null;
  // Only treat a frame of a real page as "content". about:blank produces a
  // white frame that otherwise looks like a broken/blank pane.
  const hasRealPage = hasFrame && !isBlankPage(status?.pageUrl);

  const viewportState: 'page' | 'stopped' | 'launching' | 'connecting' | 'switching' | 'ready' =
    (webrtcActive || hasRealPage) ? 'page'
      : !running && !launching ? 'stopped'
        : launching ? 'launching'
          : !connected ? 'connecting'
            : switching ? 'switching'
              : 'ready';

  const statusLabel = !connected ? 'offline'
    : launching ? 'launching'
      : audioEnabled ? 'connected · audio'
        : 'connected';

  return (
    <section className="browser-layout">
      <div className="browser-toolbar">
        <div className="browser-address-group">
          <button
            type="button"
            className="browser-toolbar-button"
            onClick={handleStart}
            disabled={busy || status?.running}
            title="Start"
            aria-label="Start browser"
          >
            ▶
          </button>
          <button
            type="button"
            className="browser-toolbar-button"
            onClick={handleStop}
            disabled={busy || !status?.running}
            title="Stop"
            aria-label="Stop browser"
          >
            ■
          </button>
          <button
            type="button"
            className={audioEnabled
              ? 'browser-toolbar-button browser-toolbar-button-active'
              : 'browser-toolbar-button'}
            onClick={handleToggleAudio}
            disabled={busy || !status?.running}
            title={audioButtonTitle}
            aria-label="Browser audio"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path
                d="M4 9v6h4l5 4V5L8 9H4zm11.5-1.5v9a5 5 0 000-9zm2.5-2.5v14a8 8 0 000-14z"
                fill="currentColor"
              />
            </svg>
          </button>
          <button
            type="button"
            className="browser-toolbar-button"
            onClick={() => send({ type: 'back' })}
            disabled={!status?.running}
            title="戻る"
            aria-label="Back"
          >
            ←
          </button>
          <button
            type="button"
            className="browser-toolbar-button"
            onClick={() => send({ type: 'forward' })}
            disabled={!status?.running}
            title="進む"
            aria-label="Forward"
          >
            →
          </button>
          <button
            type="button"
            className="browser-toolbar-button"
            onClick={() => send({ type: 'reload' })}
            disabled={!status?.running}
            title="再読み込み"
            aria-label="Reload"
          >
            ⟳
          </button>
          <form
            className="browser-address-form"
            onSubmit={(event) => {
              event.preventDefault();
              void handleNavigate();
            }}
          >
            <input
              className="browser-address-input"
              value={address}
              onChange={(event) => setAddress(event.target.value)}
              placeholder="URLを入力 (例: example.com)"
              spellCheck={false}
              autoCapitalize="off"
              autoComplete="off"
              aria-label="URL"
            />
            <button
              type="submit"
              className="browser-go-button"
              disabled={busy}
              title="Go"
              aria-label="Go"
            >
              →
            </button>
          </form>
        </div>
        <div className="browser-status-line" title={status?.profileDir || ''}>
          <span className={running ? 'browser-dot browser-dot-running' : 'browser-dot'} />
          <span>{statusLabel}</span>
        </div>
      </div>
      {running && tabs.length > 0 && (
        <div className="browser-tabs" role="tablist">
          {tabs.map((tab) => (
            <div
              key={tab.id}
              role="tab"
              aria-selected={tab.id === activeTabId}
              className={tab.id === activeTabId ? 'browser-tab browser-tab-active' : 'browser-tab'}
              onClick={() => handleActivateTab(tab.id)}
              onAuxClick={(event) => {
                // Middle-click closes, like a real browser.
                if (event.button === 1) {
                  event.preventDefault();
                  handleCloseTab(tab.id);
                }
              }}
              title={displayUrl(tab.url) ?? tabLabel(tab)}
            >
              <span className="browser-tab-title">{tabLabel(tab)}</span>
              <button
                type="button"
                className="browser-tab-close"
                onClick={(event) => {
                  event.stopPropagation();
                  handleCloseTab(tab.id);
                }}
                title="タブを閉じる"
                aria-label="タブを閉じる"
              >
                ×
              </button>
            </div>
          ))}
          <button
            type="button"
            className="browser-tab-new"
            onClick={handleNewTab}
            title="新しいタブ"
            aria-label="新しいタブ"
          >
            +
          </button>
        </div>
      )}
      {(error || audioError) && (
        <div className="browser-error">
          {error || audioError}
        </div>
      )}
      <audio ref={audioRef} className="browser-audio" />
      <div
        ref={viewportRef}
        className="browser-viewport"
        tabIndex={0}
        onKeyDown={handleKeyDown}
        onKeyUp={handleKeyUp}
      >
        {/* Always mounted so frames can be drawn before React shows it; hidden
            until we actually have a real page on screen. In WebRTC mode the
            <video> below takes over and the canvas stays hidden. */}
        <canvas
          ref={canvasRef}
          className="browser-frame"
          style={{ display: (!webrtcActive && viewportState === 'page') ? 'block' : 'none' }}
          onMouseMove={handleMouseMove}
          onMouseDown={handleMouseDown}
          onMouseUp={handleMouseUp}
          onWheel={handleWheel}
          onContextMenu={(event) => event.preventDefault()}
        />
        {/* WebRTC video sink (A1). Hidden until a track is rendering. Muted so
            autoplay is allowed; audio arrives on its own track in a later
            milestone. */}
        <video
          ref={videoRef}
          className="browser-frame"
          style={{ display: webrtcActive ? 'block' : 'none' }}
          autoPlay
          playsInline
          muted
        />
        {viewportState === 'stopped' && (
          <div className="browser-state">
            <div className="browser-state-title">ブラウザは停止中です</div>
            <button
              type="button"
              className="browser-state-action"
              onClick={handleStart}
              disabled={busy}
            >
              ▶ 起動する
            </button>
          </div>
        )}
        {viewportState === 'launching' && (
          <div className="browser-state">
            <div className="browser-spinner" aria-hidden="true" />
            <div className="browser-state-title">ブラウザを起動中…</div>
          </div>
        )}
        {viewportState === 'connecting' && (
          <div className="browser-state">
            <div className="browser-spinner" aria-hidden="true" />
            <div className="browser-state-title">接続中…</div>
          </div>
        )}
        {viewportState === 'switching' && (
          <div className="browser-state">
            <div className="browser-spinner" aria-hidden="true" />
            <div className="browser-state-title">読み込み中…</div>
          </div>
        )}
        {viewportState === 'ready' && (
          <div className="browser-state">
            <div className="browser-state-title">準備完了</div>
            <div className="browser-state-hint">上のバーにURLを入力してEnterでアクセスできます</div>
          </div>
        )}
      </div>
    </section>
  );
}
