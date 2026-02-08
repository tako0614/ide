import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentSession, CreateAgentRequest, AgentStatus } from '../types';
import {
  listAgentSessions,
  createAgentSession as apiCreateAgent,
  deleteAgentSession as apiDeleteAgent,
  streamAgentSession
} from '../api';
import {
  MESSAGE_AGENT_FETCH_ERROR,
  MESSAGE_AGENT_START_ERROR,
  MESSAGE_AGENT_DELETE_ERROR
} from '../constants';

interface UseAgentsProps {
  setStatusMessage: (message: string) => void;
}

export function useAgents({ setStatusMessage }: UseAgentsProps) {
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [sessionsLoaded, setSessionsLoaded] = useState(false);
  const streamCleanups = useRef<Map<string, () => void>>(new Map());

  const connectStream = useCallback((sessionId: string) => {
    // Don't connect if already connected
    if (streamCleanups.current.has(sessionId)) return;

    const cleanup = streamAgentSession(
      sessionId,
      (msg) => {
        setSessions((prev) =>
          prev.map((s) =>
            s.id === sessionId
              ? { ...s, messages: [...s.messages, msg] }
              : s
          )
        );
      },
      (status: AgentStatus, extra) => {
        setSessions((prev) =>
          prev.map((s) =>
            s.id === sessionId
              ? {
                  ...s,
                  status,
                  error: extra?.error || s.error,
                  durationMs: extra?.durationMs || s.durationMs,
                  totalCostUsd: extra?.totalCostUsd ?? s.totalCostUsd
                }
              : s
          )
        );
        // Clean up stream on terminal states
        if (status === 'completed' || status === 'error' || status === 'aborted') {
          const c = streamCleanups.current.get(sessionId);
          if (c) {
            c();
            streamCleanups.current.delete(sessionId);
          }
        }
      },
      () => {
        // SSE error - clean up
        streamCleanups.current.delete(sessionId);
      }
    );

    streamCleanups.current.set(sessionId, cleanup);
  }, []);

  // Load sessions on mount
  useEffect(() => {
    let alive = true;
    listAgentSessions()
      .then((data) => {
        if (!alive) return;
        setSessions(data);
        setSessionsLoaded(true);
        // Connect SSE for running sessions
        for (const session of data) {
          if (session.status === 'running' || session.status === 'idle') {
            connectStream(session.id);
          }
        }
      })
      .catch((err: unknown) => {
        if (!alive) return;
        setStatusMessage(
          `${MESSAGE_AGENT_FETCH_ERROR}: ${err instanceof Error ? err.message : String(err)}`
        );
      });

    return () => {
      alive = false;
    };
  }, [setStatusMessage, connectStream]);

  // Cleanup all streams on unmount
  useEffect(() => {
    const cleanups = streamCleanups.current;
    return () => {
      for (const cleanup of cleanups.values()) {
        cleanup();
      }
      cleanups.clear();
    };
  }, []);

  const handleCreateAgent = useCallback(
    async (req: CreateAgentRequest) => {
      try {
        const session = await apiCreateAgent(req);
        setSessions((prev) => [...prev, session]);
        connectStream(session.id);
        return session;
      } catch (err: unknown) {
        setStatusMessage(
          `${MESSAGE_AGENT_START_ERROR}: ${err instanceof Error ? err.message : String(err)}`
        );
        return null;
      }
    },
    [setStatusMessage, connectStream]
  );

  const handleDeleteAgent = useCallback(
    async (id: string) => {
      try {
        // Clean up stream first
        const cleanup = streamCleanups.current.get(id);
        if (cleanup) {
          cleanup();
          streamCleanups.current.delete(id);
        }
        await apiDeleteAgent(id);
        setSessions((prev) => prev.filter((s) => s.id !== id));
      } catch (err: unknown) {
        setStatusMessage(
          `${MESSAGE_AGENT_DELETE_ERROR}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    },
    [setStatusMessage]
  );

  return {
    sessions,
    sessionsLoaded,
    handleCreateAgent,
    handleDeleteAgent
  };
}
