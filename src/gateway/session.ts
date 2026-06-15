/**
 * In-memory session store for per-chat conversation history.
 *
 * Inspired by Hermes Agent's session management, but stripped down
 * for a barebones implementation. Messages are kept in RAM only;
 * persistence can be added later.
 */

import type { MessageEvent } from "./types.js";

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: Date;
  platformMessageId?: string;
}

export interface ChatSession {
  chatId: string;
  platform: string;
  messages: ChatMessage[];
  lastActivity: Date;
  metadata: Record<string, unknown>;
}

export class SessionStore {
  private sessions = new Map<string, ChatSession>();

  private key(platform: string, chatId: string): string {
    return `${platform}:${chatId}`;
  }

  getSession(platform: string, chatId: string): ChatSession {
    const k = this.key(platform, chatId);
    let session = this.sessions.get(k);
    if (!session) {
      session = {
        chatId,
        platform,
        messages: [],
        lastActivity: new Date(),
        metadata: {},
      };
      this.sessions.set(k, session);
    }
    return session;
  }

  addUserMessage(event: MessageEvent): ChatMessage {
    const session = this.getSession(event.platform, event.chatId);
    const msg: ChatMessage = {
      role: "user",
      content: event.text,
      timestamp: event.timestamp,
      platformMessageId: event.id,
    };
    session.messages.push(msg);
    session.lastActivity = new Date();
    return msg;
  }

  addAssistantMessage(
    platform: string,
    chatId: string,
    content: string,
    platformMessageId?: string
  ): ChatMessage {
    const session = this.getSession(platform, chatId);
    const msg: ChatMessage = {
      role: "assistant",
      content,
      timestamp: new Date(),
      platformMessageId,
    };
    session.messages.push(msg);
    session.lastActivity = new Date();
    return msg;
  }

  getMessages(platform: string, chatId: string): ChatMessage[] {
    return this.getSession(platform, chatId).messages;
  }

  clearSession(platform: string, chatId: string): void {
    this.sessions.delete(this.key(platform, chatId));
  }

  /** Reset sessions idle longer than maxAgeMinutes */
  purgeIdle(maxAgeMinutes: number): number {
    const now = Date.now();
    let purged = 0;
    for (const [k, session] of this.sessions.entries()) {
      const ageMin = (now - session.lastActivity.getTime()) / 60000;
      if (ageMin > maxAgeMinutes) {
        this.sessions.delete(k);
        purged++;
      }
    }
    return purged;
  }

  /** Total active sessions */
  get sessionCount(): number {
    return this.sessions.size;
  }
}
