import crypto from 'node:crypto';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { DatabaseSync } from 'node:sqlite';
import type { AgentSessionData, AgentMessage, Workspace } from '../types.js';
import { MAX_CONCURRENT_AGENTS, MAX_AGENT_COST_USD, MAX_AGENT_MESSAGES, MAX_AGENT_PROMPT_LENGTH } from '../config.js';
import {
  saveAgentSession,
  updateAgentSession,
  loadAgentSessions,
  deleteAgentSession
} from '../utils/database.js';

interface RunningAgent {
  session: AgentSessionData;
  abortController: AbortController;
  emitter: EventEmitter;
}

// Auto-cleanup completed sessions older than this (1 hour)
const SESSION_TTL_MS = 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

export function createAgentRouter(db: DatabaseSync, workspaces: Map<string, Workspace>) {
  const router = new Hono();
  const runningAgents = new Map<string, RunningAgent>();

  // Load persisted sessions
  const sessions = new Map<string, AgentSessionData>();
  const persisted = loadAgentSessions(db);
  for (const s of persisted) {
    // Mark previously running sessions as aborted
    if (s.status === 'running' || s.status === 'idle') {
      s.status = 'aborted';
      updateAgentSession(db, s.id, { status: 'aborted' });
    }
    sessions.set(s.id, s);
  }

  // Periodic cleanup of old completed/error/aborted sessions
  const cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [id, session] of sessions) {
      if (session.status === 'running' || session.status === 'idle') continue;
      const age = now - new Date(session.createdAt).getTime();
      if (age > SESSION_TTL_MS) {
        sessions.delete(id);
        deleteAgentSession(db, id);
      }
    }
  }, CLEANUP_INTERVAL_MS);
  // Don't block Node exit
  if (cleanupTimer.unref) cleanupTimer.unref();

  function getRunningCount(): number {
    return runningAgents.size;
  }

  function broadcastMessage(agentId: string, event: string, data: unknown): Promise<void> {
    const running = runningAgents.get(agentId);
    if (running) {
      running.emitter.emit('sse', { event, data });
      // Give SSE write queue time to flush before caller proceeds
      return new Promise((resolve) => setImmediate(resolve));
    }
    return Promise.resolve();
  }

  function formatSdkError(provider: string, err: unknown): string {
    if (err instanceof Error) {
      // Detect missing SDK
      if (err.message.includes('Cannot find module') || err.message.includes('ERR_MODULE_NOT_FOUND')) {
        return `${provider} SDK is not installed. Run: npm install ${provider === 'claude' ? '@anthropic-ai/claude-agent-sdk' : '@openai/codex-sdk'}`;
      }
      return err.message;
    }
    return String(err);
  }

  // Parse Claude SDK streamed messages into AgentMessage[]
  // SDK message types: system (init), assistant (message.content[]), user (tool results), result (final)
  // Returns an array because a single assistant message can contain both text and tool_use blocks
  function parseClaudeMessages(sdkMsg: Record<string, unknown>): AgentMessage[] {
    const msgType = String(sdkMsg.type || '');

    if (msgType === 'assistant') {
      // assistant message has message.content[] array
      const inner = sdkMsg.message as Record<string, unknown> | undefined;
      const contentArr = inner?.content as Array<Record<string, unknown>> | undefined;
      if (!contentArr || contentArr.length === 0) return [];

      const messages: AgentMessage[] = [];
      const textParts: string[] = [];

      for (const block of contentArr) {
        if (block.type === 'text' && typeof block.text === 'string') {
          textParts.push(block.text);
        } else if (block.type === 'tool_use') {
          // Flush accumulated text as an assistant message first
          if (textParts.length > 0) {
            messages.push({
              id: crypto.randomUUID(),
              role: 'assistant',
              content: textParts.join('\n'),
              timestamp: new Date().toISOString()
            });
            textParts.length = 0;
          }
          const toolName = String(block.name || 'tool');
          const input = block.input ? JSON.stringify(block.input) : '';
          messages.push({
            id: crypto.randomUUID(),
            role: 'tool',
            content: `[${toolName}] ${input}`,
            timestamp: new Date().toISOString(),
            toolName
          });
        }
      }

      // Flush remaining text
      if (textParts.length > 0) {
        messages.push({
          id: crypto.randomUUID(),
          role: 'assistant',
          content: textParts.join('\n'),
          timestamp: new Date().toISOString()
        });
      }

      return messages;
    }

    if (msgType === 'user') {
      // user message = tool results, skip to avoid noise
      return [];
    }

    if (msgType === 'result') {
      const result = sdkMsg.result;
      if (!result) return [];
      return [{
        id: crypto.randomUUID(),
        role: 'system',
        content: typeof result === 'string' ? result : JSON.stringify(result),
        timestamp: new Date().toISOString()
      }];
    }

    // system/init messages - skip
    return [];
  }

  async function runClaudeAgent(agent: RunningAgent) {
    const { session, abortController } = agent;
    const startTime = Date.now();

    try {
      session.status = 'running';
      updateAgentSession(db, session.id, { status: 'running' });
      await broadcastMessage(session.id, 'status', { status: 'running' });

      // Dynamic import of Claude Agent SDK
      let queryFn: (opts: unknown) => AsyncIterable<unknown>;
      try {
        const mod = await import('@anthropic-ai/claude-agent-sdk');
        queryFn = mod.query;
      } catch (importErr) {
        throw new Error(formatSdkError('claude', importErr));
      }

      let resultCost: number | undefined;
      let resultDuration: number | undefined;

      for await (const message of queryFn({
        prompt: session.prompt,
        options: {
          allowedTools: ['Read', 'Edit', 'Bash', 'Glob', 'Grep', 'Write'],
          cwd: session.cwd,
          permissionMode: 'bypassPermissions',
          maxTurns: 30,
          abortController
        }
      })) {
        if (abortController.signal.aborted) break;

        const sdkMsg = message as Record<string, unknown>;

        // Extract cost/duration from result message
        if (sdkMsg.type === 'result') {
          if (typeof sdkMsg.total_cost_usd === 'number') resultCost = sdkMsg.total_cost_usd;
          if (typeof sdkMsg.duration_ms === 'number') resultDuration = sdkMsg.duration_ms;
        }

        // Cost limit check
        if (resultCost != null) {
          const costLimit = session.maxCostUsd ?? MAX_AGENT_COST_USD;
          if (resultCost >= costLimit) {
            abortController.abort();
            session.status = 'error';
            session.error = `Cost limit exceeded ($${resultCost.toFixed(2)} >= $${costLimit.toFixed(2)})`;
            session.totalCostUsd = resultCost;
            session.durationMs = Date.now() - startTime;
            updateAgentSession(db, session.id, {
              status: 'error',
              error: session.error,
              totalCostUsd: resultCost,
              messages: session.messages,
              durationMs: session.durationMs
            });
            await broadcastMessage(session.id, 'status', { status: 'error', error: session.error });
            break;
          }
        }

        const agentMsgs = parseClaudeMessages(sdkMsg);
        for (const agentMsg of agentMsgs) {
          session.messages.push(agentMsg);
          await broadcastMessage(session.id, 'message', agentMsg);
        }

        // Trim old messages if exceeding limit (keep first message for context)
        if (session.messages.length > MAX_AGENT_MESSAGES) {
          session.messages = [session.messages[0], ...session.messages.slice(-(MAX_AGENT_MESSAGES - 1))];
        }

        // Persist periodically
        if (session.messages.length % 5 === 0) {
          updateAgentSession(db, session.id, { messages: session.messages });
        }
      }

      if (abortController.signal.aborted) {
        // Abort didn't throw - update status here
        session.status = 'aborted';
        updateAgentSession(db, session.id, { status: 'aborted', messages: session.messages });
        await broadcastMessage(session.id, 'status', { status: 'aborted' });
      } else {
        session.status = 'completed';
        session.durationMs = resultDuration ?? (Date.now() - startTime);
        session.totalCostUsd = resultCost;
        updateAgentSession(db, session.id, {
          status: 'completed',
          messages: session.messages,
          durationMs: session.durationMs,
          totalCostUsd: session.totalCostUsd
        });
        await broadcastMessage(session.id, 'status', {
          status: 'completed',
          durationMs: session.durationMs,
          totalCostUsd: session.totalCostUsd
        });
      }
    } catch (err: unknown) {
      if (abortController.signal.aborted) {
        session.status = 'aborted';
        updateAgentSession(db, session.id, { status: 'aborted', messages: session.messages });
        await broadcastMessage(session.id, 'status', { status: 'aborted' });
      } else {
        const errorMsg = formatSdkError('claude', err);
        session.status = 'error';
        session.error = errorMsg;
        session.durationMs = Date.now() - startTime;
        updateAgentSession(db, session.id, {
          status: 'error',
          error: errorMsg,
          messages: session.messages,
          durationMs: session.durationMs
        });
        await broadcastMessage(session.id, 'status', { status: 'error', error: errorMsg });
      }
    } finally {
      runningAgents.delete(session.id);
      // Only persist if session wasn't deleted externally (by DELETE handler)
      if (sessions.has(session.id)) {
        sessions.set(session.id, session);
      }
    }
  }

  async function runCodexAgent(agent: RunningAgent) {
    const { session, abortController } = agent;
    const startTime = Date.now();

    try {
      session.status = 'running';
      updateAgentSession(db, session.id, { status: 'running' });
      await broadcastMessage(session.id, 'status', { status: 'running' });

      // Dynamic import of Codex SDK
      let CodexClass: new () => { startThread(): { run(prompt: string): Promise<unknown> } };
      try {
        const codexModule = await import('@openai/codex-sdk');
        CodexClass = codexModule.Codex;
      } catch (importErr) {
        throw new Error(formatSdkError('codex', importErr));
      }

      const codex = new CodexClass();
      const thread = codex.startThread();
      const result = await thread.run(session.prompt);

      if (abortController.signal.aborted) {
        // Abort didn't throw - update status here
        session.status = 'aborted';
        updateAgentSession(db, session.id, { status: 'aborted', messages: session.messages });
        await broadcastMessage(session.id, 'status', { status: 'aborted' });
      } else {
        const agentMsg: AgentMessage = {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: typeof result === 'string' ? result : JSON.stringify(result),
          timestamp: new Date().toISOString()
        };

        session.messages.push(agentMsg);
        await broadcastMessage(session.id, 'message', agentMsg);

        // Trim old messages if exceeding limit (keep first message for context)
        if (session.messages.length > MAX_AGENT_MESSAGES) {
          session.messages = [session.messages[0], ...session.messages.slice(-(MAX_AGENT_MESSAGES - 1))];
        }

        session.status = 'completed';
        session.durationMs = Date.now() - startTime;
        updateAgentSession(db, session.id, {
          status: 'completed',
          messages: session.messages,
          durationMs: session.durationMs
        });
        await broadcastMessage(session.id, 'status', { status: 'completed', durationMs: session.durationMs });
      }
    } catch (err: unknown) {
      if (abortController.signal.aborted) {
        session.status = 'aborted';
        updateAgentSession(db, session.id, { status: 'aborted', messages: session.messages });
        await broadcastMessage(session.id, 'status', { status: 'aborted' });
      } else {
        const errorMsg = formatSdkError('codex', err);
        session.status = 'error';
        session.error = errorMsg;
        session.durationMs = Date.now() - startTime;
        updateAgentSession(db, session.id, {
          status: 'error',
          error: errorMsg,
          messages: session.messages,
          durationMs: session.durationMs
        });
        await broadcastMessage(session.id, 'status', { status: 'error', error: errorMsg });
      }
    } finally {
      runningAgents.delete(session.id);
      // Only persist if session wasn't deleted externally (by DELETE handler)
      if (sessions.has(session.id)) {
        sessions.set(session.id, session);
      }
    }
  }

  // GET /api/agents - list all sessions
  router.get('/', (c) => {
    const allSessions = Array.from(sessions.values());
    return c.json(allSessions);
  });

  // POST /api/agents - create and start agent
  router.post('/', async (c) => {
    if (getRunningCount() >= MAX_CONCURRENT_AGENTS) {
      return c.json(
        { error: `Maximum concurrent agents (${MAX_CONCURRENT_AGENTS}) reached` },
        429
      );
    }

    const body = await c.req.json<{ provider: string; prompt: string; cwd: string; maxCostUsd?: number }>();
    const { provider, prompt, cwd, maxCostUsd } = body;

    if (!provider || !prompt || !cwd) {
      return c.json({ error: 'provider, prompt, and cwd are required' }, 400);
    }

    if (provider !== 'claude' && provider !== 'codex') {
      return c.json({ error: 'provider must be "claude" or "codex"' }, 400);
    }

    // Validate prompt length
    if (prompt.length > MAX_AGENT_PROMPT_LENGTH) {
      return c.json({ error: `Prompt too long (max ${MAX_AGENT_PROMPT_LENGTH} chars)` }, 400);
    }

    // Validate cwd is within a registered workspace (path traversal protection)
    const resolvedCwd = path.resolve(cwd);
    const validCwd = Array.from(workspaces.values()).some((w) => {
      const resolvedWorkspacePath = path.resolve(w.path);
      return resolvedCwd === resolvedWorkspacePath || resolvedCwd.startsWith(resolvedWorkspacePath + path.sep);
    });
    if (!validCwd) {
      return c.json({ error: 'cwd must be within a registered workspace' }, 400);
    }

    const session: AgentSessionData = {
      id: crypto.randomUUID(),
      provider: provider as AgentSessionData['provider'],
      prompt,
      cwd: resolvedCwd,
      status: 'idle',
      messages: [],
      createdAt: new Date().toISOString(),
      maxCostUsd: maxCostUsd != null ? maxCostUsd : MAX_AGENT_COST_USD
    };

    sessions.set(session.id, session);
    saveAgentSession(db, session);

    const abortController = new AbortController();
    const emitter = new EventEmitter();
    const agent: RunningAgent = { session, abortController, emitter };
    runningAgents.set(session.id, agent);

    // Start agent asynchronously
    if (provider === 'claude') {
      runClaudeAgent(agent).catch((err) => {
        console.error(`[AGENT] Claude agent ${session.id} failed:`, err);
      });
    } else {
      runCodexAgent(agent).catch((err) => {
        console.error(`[AGENT] Codex agent ${session.id} failed:`, err);
      });
    }

    return c.json(session, 201);
  });

  // IMPORTANT: Register /stream route BEFORE /:id to avoid Hono matching /:id first
  // GET /api/agents/:id/stream - SSE stream
  router.get('/:id/stream', (c) => {
    const id = c.req.param('id');
    const session = sessions.get(id);
    if (!session) {
      return c.json({ error: 'Agent session not found' }, 404);
    }

    return streamSSE(c, async (stream) => {
      // Send current state first
      await stream.writeSSE({
        event: 'init',
        data: JSON.stringify(session)
      });

      const running = runningAgents.get(id);
      if (!running || session.status === 'completed' || session.status === 'error' || session.status === 'aborted') {
        await stream.writeSSE({
          event: 'status',
          data: JSON.stringify({ status: session.status })
        });
        return;
      }

      // Queue writes to prevent concurrent writeSSE calls
      const writeQueue: { event: string; data: unknown }[] = [];
      let writing = false;

      async function flushQueue() {
        if (writing) return;
        writing = true;
        while (writeQueue.length > 0) {
          const item = writeQueue.shift()!;
          try {
            await stream.writeSSE({
              event: item.event,
              data: JSON.stringify(item.data)
            });
          } catch {
            // Client disconnected - stop processing
            running.emitter.off('sse', onSSE);
            writeQueue.length = 0;
            break;
          }
        }
        writing = false;
      }

      const onSSE = (payload: { event: string; data: unknown }) => {
        writeQueue.push(payload);
        flushQueue();
      };

      running.emitter.on('sse', onSSE);

      // Keep connection alive until agent finishes or client disconnects
      await new Promise<void>((resolve) => {
        const checkDone = () => {
          if (!runningAgents.has(id)) {
            clearInterval(interval);
            running.emitter.off('sse', onSSE);
            resolve();
          }
        };

        const interval = setInterval(checkDone, 1000);
        stream.onAbort(() => {
          clearInterval(interval);
          running.emitter.off('sse', onSSE);
          resolve();
        });
      });
    });
  });

  // GET /api/agents/:id - get session details
  router.get('/:id', (c) => {
    const session = sessions.get(c.req.param('id'));
    if (!session) {
      return c.json({ error: 'Agent session not found' }, 404);
    }
    return c.json(session);
  });

  // DELETE /api/agents/:id - abort and/or delete
  router.delete('/:id', (c) => {
    const id = c.req.param('id');
    const running = runningAgents.get(id);
    if (running) {
      running.abortController.abort();
      runningAgents.delete(id);
    }

    const session = sessions.get(id);
    if (!session) {
      return c.json({ error: 'Agent session not found' }, 404);
    }

    sessions.delete(id);
    deleteAgentSession(db, id);
    return c.body(null, 204);
  });

  function abortAllAgents() {
    clearInterval(cleanupTimer);
    for (const [id, agent] of runningAgents) {
      agent.abortController.abort();
      runningAgents.delete(id);
    }
  }

  return { router, abortAllAgents };
}
