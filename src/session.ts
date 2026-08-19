import {
  createSession,
  deleteSession,
  normalizeProjectPath,
  type Message as SessionMessage,
} from "cc-session-io";
import { randomUUID } from "node:crypto";

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

    if (historyMessages.length === 0) {
      // First turn of a fresh conversation
      state.cursor = 0;
      state.cwd = normalizedCwd;
      // If we already have a written session or previous session, return it if resume desired, or null for fresh
      return null;
    }

    // Reuse path: If history hasn't diverged and session was written or captured
    if (state.hasWrittenSession && state.cursor === historyMessages.length && state.cwd === normalizedCwd) {
      return state.claudeSessionId;
    }

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
