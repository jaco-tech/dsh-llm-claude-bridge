import {
  createSession,
  deleteSession,
  normalizeProjectPath,
  type Message as SessionMessage,
} from "cc-session-io";
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";

export interface SessionState {
  claudeSessionId: string;
  cursor: number;
  cwd: string;
  hasWrittenSession: boolean;
}

export class SessionManager {
  private sessions = new Map<string, SessionState>();

  getOrCreate(dshSessionId: string | undefined): SessionState {
    const key = dshSessionId || "default";
    let state = this.sessions.get(key);
    if (!state) {
      state = {
        claudeSessionId: randomUUID(),
        cursor: 0,
        cwd: process.cwd(),
        hasWrittenSession: false,
      };
      this.sessions.set(key, state);
    }
    return state;
  }

  recordCapturedSessionId(
    dshSessionId: string | undefined,
    capturedId: string,
    cwd: string,
    cursor: number,
  ): void {
    const key = dshSessionId || "default";
    const state = this.getOrCreate(dshSessionId);
    state.claudeSessionId = capturedId;
    state.cwd = normalizeProjectPath(cwd);
    state.cursor = cursor;
    state.hasWrittenSession = true;
  }

  async syncSession(
    dshSessionId: string | undefined,
    historyMessages: SessionMessage[],
    cwd: string,
    modelId: string,
  ): Promise<string | null> {
    const normalizedCwd = normalizeProjectPath(cwd);
    const state = this.getOrCreate(dshSessionId);
    const debug = (msg: string) => {
      if (!process.env.CLAUDE_BRIDGE_DEBUG) return;
      const line = `[cb-debug] syncSession dsh=${dshSessionId} ${msg}`;
      console.error(line);
      try {
        appendFileSync("/tmp/cb-debug.log", line + "\n");
      } catch {}
    };

    if (historyMessages.length === 0) {
      // First turn of a fresh conversation
      state.cursor = 0;
      state.cwd = normalizedCwd;
      debug(`path=clean-start (no history)`);
      // If we already have a written session or previous session, return it if resume desired, or null for fresh
      return null;
    }

    // Reuse path: the captured session on disk is Claude Code's own record of
    // this conversation. As long as history has only grown since capture (the
    // normal agent-loop continuation), resume that live file — do NOT rewrite
    // it. Rewriting (rebuild path) replaces Claude Code's genuine transcript —
    // tool_use blocks, tool results, interruption markers — with a synthetic
    // cc-session-io reconstruction, and a resumed model reads that
    // reconstruction as an aborted session, answering with the "no prior work
    // ... interrupted" stub instead of continuing its task.
    if (state.hasWrittenSession && state.cwd === normalizedCwd && historyMessages.length >= state.cursor) {
      state.cursor = historyMessages.length;
      debug(`path=reuse claude=${state.claudeSessionId} cursor=${state.cursor} hist=${historyMessages.length}`);
      return state.claudeSessionId;
    }

    debug(`path=REBUILD claude=${state.claudeSessionId} cursor=${state.cursor} hist=${historyMessages.length} written=${state.hasWrittenSession} cwdMatch=${state.cwd === normalizedCwd}`);

    // Rebuild path: write full history to Claude Code session file
    try {
      deleteSession(state.claudeSessionId, normalizedCwd);
    } catch {}

    const session = createSession({
      sessionId: state.claudeSessionId,
      projectPath: normalizedCwd,
      cwd: normalizedCwd,
      model: modelId,
    });

    session.importMessages(historyMessages);
    await session.save();

    state.cursor = historyMessages.length;
    state.cwd = normalizedCwd;
    state.hasWrittenSession = true;

    return state.claudeSessionId;
  }

  deleteSession(dshSessionId: string | undefined): void {
    const key = dshSessionId || "default";
    const state = this.sessions.get(key);
    if (state) {
      try {
        deleteSession(state.claudeSessionId, state.cwd);
      } catch {}
      this.sessions.delete(key);
    }
  }
}
