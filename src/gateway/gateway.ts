/**
 * Gateway orchestrator — the heart of the messaging system.
 *
 * Inspired by Hermes Agent's gateway module. Responsibilities:
 *  - Instantiate platform adapters from config
 *  - Route incoming messages to the DeepAgent
 *  - Route agent responses back to the originating platform
 *  - Manage per-chat sessions
 */

import type { DeepAgent } from "deepagents";
import type { BasePlatformAdapter } from "./platforms/base.js";
import { TelegramAdapter } from "./platforms/telegram.js";
import { WhatsAppAdapter } from "./platforms/whatsapp.js";
import { SessionStore } from "./session.js";
import { platformRegistry } from "./registry.js";
import type { GatewayConfig, MessageEvent, PlatformConfig } from "./types.js";

// Register built-in adapters
platformRegistry.register({
  name: "telegram",
  label: "Telegram",
  factory: (cfg) =>
    new TelegramAdapter({
      botToken: cfg.botToken as string,
      allowedUsers: cfg.allowedUsers as string[] | undefined,
      requireMention: cfg.requireMention as boolean | undefined,
    }),
  requiredEnv: ["TELEGRAM_BOT_TOKEN"],
});

platformRegistry.register({
  name: "whatsapp",
  label: "WhatsApp",
  factory: (cfg) =>
    new WhatsAppAdapter({
      authDir: (cfg.authDir as string) || ".whatsapp-auth",
      allowFrom: cfg.allowFrom as string[] | undefined,
      allowGroups: cfg.allowGroups as string[] | undefined,
      requireMention: cfg.requireMention as boolean | undefined,
    }),
  requiredEnv: [], // WhatsApp uses file-based auth, no env key needed
});

export class Gateway {
  private adapters = new Map<string, BasePlatformAdapter>();
  private sessions = new SessionStore();
  private agent: DeepAgent;
  private config: GatewayConfig;
  private purgeInterval?: NodeJS.Timeout;

  constructor(agent: DeepAgent, config: GatewayConfig) {
    this.agent = agent;
    this.config = config;
  }

  async start(): Promise<void> {
    console.log("[Gateway] starting...");

    // Initialize adapters for enabled platforms
    for (const pc of this.config.platforms) {
      if (!pc.enabled) continue;

      const entry = platformRegistry.get(pc.platform);
      if (!entry) {
        console.warn(`[Gateway] unknown platform: ${pc.platform}`);
        continue;
      }

      try {
        const adapter = entry.factory(pc.extra || {});
        adapter.onMessage((event) => this.handleMessage(event));
        await adapter.connect();
        this.adapters.set(pc.platform, adapter);
        console.log(`[Gateway] ${entry.label} connected`);
      } catch (err) {
        console.error(`[Gateway] failed to start ${entry.label}:`, err);
      }
    }

    // Session purge timer (if configured)
    if (this.config.resetPolicy === "after_minutes" && this.config.resetAfterMinutes) {
      const ms = this.config.resetAfterMinutes * 60 * 1000;
      this.purgeInterval = setInterval(() => {
        const purged = this.sessions.purgeIdle(this.config.resetAfterMinutes!);
        if (purged > 0) {
          console.log(`[Gateway] purged ${purged} idle sessions`);
        }
      }, Math.min(ms, 60000)); // Check at most every minute
    }

    console.log(`[Gateway] running with ${this.adapters.size} platform(s)`);
  }

  async stop(): Promise<void> {
    console.log("[Gateway] stopping...");
    if (this.purgeInterval) {
      clearInterval(this.purgeInterval);
    }
    for (const [name, adapter] of this.adapters.entries()) {
      try {
        await adapter.disconnect();
        console.log(`[Gateway] ${name} disconnected`);
      } catch (err) {
        console.error(`[Gateway] error disconnecting ${name}:`, err);
      }
    }
    this.adapters.clear();
  }

  private async handleMessage(event: MessageEvent): Promise<void> {
    console.log(
      `[Gateway] ${event.platform}:${event.chatId} <${event.senderName}>: ${event.text.slice(0, 80)}`
    );

    // Add user message to session history
    this.sessions.addUserMessage(event);

    // Build message array from session history
    const history = this.sessions.getMessages(event.platform, event.chatId);
    const messages = history.map((m) => ({
      role: m.role,
      content: m.content,
    }));

    try {
      // Invoke the agent
      const result = await this.agent.invoke({ messages });

      // Extract text response from the agent result
      const responseText = this.extractText(result);

      // Add assistant response to session
      this.sessions.addAssistantMessage(event.platform, event.chatId, responseText);

      // Send back to originating platform
      const adapter = this.adapters.get(event.platform);
      if (adapter) {
        await adapter.sendMessage(event.chatId, responseText, {
          replyTo: event.id,
          parseMode: "markdown",
        });
      }
    } catch (err) {
      console.error("[Gateway] agent error:", err);
      const adapter = this.adapters.get(event.platform);
      if (adapter) {
        await adapter.sendMessage(
          event.chatId,
          "❌ Sorry, I encountered an error processing your request."
        );
      }
    }
  }

  private extractText(result: unknown): string {
    // DeepAgent returns different shapes depending on config.
    // Common cases: string, { content: string }, { messages: [...] }
    if (typeof result === "string") return result;
    if (result && typeof result === "object") {
      const r = result as Record<string, unknown>;
      if (typeof r.content === "string") return r.content;
      if (Array.isArray(r.messages)) {
        const last = r.messages[r.messages.length - 1] as Record<string, unknown> | undefined;
        if (last && typeof last.content === "string") return last.content;
      }
    }
    return JSON.stringify(result);
  }

  status(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [name, adapter] of this.adapters.entries()) {
      out[name] = adapter.status();
    }
    out.sessions = `${this.sessions.sessionCount} active`;
    return out;
  }
}
