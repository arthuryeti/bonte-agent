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
import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import path from "node:path";
import type { BasePlatformAdapter } from "./platforms/base.js";
import { TelegramAdapter } from "./platforms/telegram.js";
import { WhatsAppAdapter } from "./platforms/whatsapp.js";
import { SessionStore } from "./session.js";
import { platformRegistry } from "./registry.js";
import {
  extractAllMessageText,
  extractContentText,
  extractLastAssistantText,
} from "../agent-response.js";
import {
  extractMediaDelivery,
  mimeTypeForDocument,
} from "../media-delivery.js";
import type {
  GatewayConfig,
  MessageEvent,
  PlatformConfig,
  SentMessageRef,
} from "./types.js";

interface LiveAgentResult {
  result: unknown;
  streamedMessage?: SentMessageRef;
}

class AgentTraceCallback extends BaseCallbackHandler {
  name = "AgentTraceCallback";
  private toolRuns = new Map<string, string>();
  private documentToolOutputs: unknown[] = [];

  handleToolStart(
    tool: unknown,
    input: string,
    runId: string,
    _parentRunId?: string,
    _tags?: string[],
    _metadata?: Record<string, unknown>,
    runName?: string
  ): void {
    const toolName = this.toolName(tool, runName);
    this.toolRuns.set(runId, toolName);

    if (toolName === "task") {
      console.log(
        `[DeepAgent] sub-agent started: ${this.describeTaskInput(input)}`
      );
      return;
    }

    if (process.env.DEEPAGENT_TOOL_LOGS === "true") {
      console.log(`[DeepAgent] tool started: ${toolName}`);
    }
  }

  handleToolEnd(output: unknown, runId: string): void {
    const toolName = this.toolRuns.get(runId);
    if (!toolName) return;

    if (toolName === "generate_property_pdf") {
      this.documentToolOutputs.push(output);
    }

    if (toolName === "task") {
      console.log("[DeepAgent] sub-agent completed");
    } else if (process.env.DEEPAGENT_TOOL_LOGS === "true") {
      console.log(`[DeepAgent] tool completed: ${toolName}`);
    }

    this.toolRuns.delete(runId);
  }

  getDocumentToolOutputs(): readonly unknown[] {
    return this.documentToolOutputs;
  }

  handleToolError(err: unknown, runId: string): void {
    const toolName = this.toolRuns.get(runId);
    if (toolName === "task") {
      console.warn(
        `[DeepAgent] sub-agent failed: ${this.errorMessage(err)}`
      );
    } else if (toolName && process.env.DEEPAGENT_TOOL_LOGS === "true") {
      console.warn(
        `[DeepAgent] tool failed: ${toolName}: ${this.errorMessage(err)}`
      );
    }

    this.toolRuns.delete(runId);
  }

  private toolName(tool: unknown, runName?: string): string {
    if (runName) return runName;
    if (!tool || typeof tool !== "object") return "unknown";

    const record = tool as Record<string, unknown>;
    if (typeof record.name === "string") return record.name;
    if (typeof record.id === "string") return record.id.split("/").at(-1) || record.id;
    return "unknown";
  }

  private describeTaskInput(input: string): string {
    const parsed = this.parseInput(input);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      const agentName = this.firstString(
        record.subagent_type,
        record.subagent,
        record.name
      );
      const description = this.firstString(
        record.description,
        record.prompt,
        record.task
      );

      return [agentName, description && this.truncate(description, 160)]
        .filter(Boolean)
        .join(" - ") || this.truncate(input, 160);
    }

    return this.truncate(input, 160);
  }

  private parseInput(input: string): unknown {
    try {
      return JSON.parse(input);
    } catch {
      return undefined;
    }
  }

  private firstString(...values: unknown[]): string | undefined {
    return values.find((value): value is string => typeof value === "string");
  }

  private truncate(value: string, maxLength: number): string {
    if (value.length <= maxLength) return value;
    return `${value.slice(0, maxLength - 3)}...`;
  }

  private errorMessage(err: unknown): string {
    if (err instanceof Error) return err.message;
    return String(err);
  }
}

// Register built-in adapters
platformRegistry.register({
  name: "telegram",
  label: "Telegram",
  factory: (cfg) =>
    new TelegramAdapter({
      botToken: cfg.botToken as string,
      allowedUsers: cfg.allowedUsers as string[] | undefined,
      requireMention: cfg.requireMention as boolean | undefined,
      typingIndicator: cfg.typingIndicator as boolean | undefined,
      streamUpdates: cfg.streamUpdates as boolean | undefined,
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
      debug: cfg.debug as boolean | undefined,
      sendTimeoutMs: cfg.sendTimeoutMs as number | undefined,
      chunkDelayMs: cfg.chunkDelayMs as number | undefined,
    }),
  requiredEnv: [], // WhatsApp uses file-based auth, no env key needed
});

export class Gateway {
  private adapters = new Map<string, BasePlatformAdapter>();
  private sessions = new SessionStore();
  private agent: DeepAgent;
  private config: GatewayConfig;
  private purgeInterval?: NodeJS.Timeout;
  private liveAgentStreamingDisabled = false;

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

    const adapter = this.adapters.get(event.platform);
    if (this.isResetCommand(event.text)) {
      this.sessions.clearSession(event.platform, event.chatId);
      if (adapter) {
        await adapter.sendMessage(
          event.chatId,
          "Conversation reset. I’ll use a fresh context for your next request.",
          { replyTo: event.id }
        );
      }
      return;
    }

    // Add user message to session history
    this.sessions.addUserMessage(event);

    // Build message array from session history
    const history = this.sessions.getMessages(event.platform, event.chatId);
    const messages = history.map((m) => ({
      role: m.role,
      content: m.content,
    }));

    const traceCallback = new AgentTraceCallback();
    const callbacks = [traceCallback];

    try {
      const liveResult: LiveAgentResult =
        adapter?.supportsMessageUpdates() && this.canStreamAgent()
          ? await this.invokeAgentWithLiveUpdates(
              messages,
              event,
              adapter,
              callbacks
            )
          : {
              result: await this.withTypingIndicator(adapter, event.chatId, () =>
                this.agent.invoke({ messages }, { callbacks })
              ),
            };
      const result = liveResult.result;
      // Extract text response from the agent result
      const responseText = extractLastAssistantText(result);
      const delivery = extractMediaDelivery(responseText);
      const hiddenDelivery = extractMediaDelivery(
        extractAllMessageText(result)
      );
      const toolDeliveries = traceCallback
        .getDocumentToolOutputs()
        .map((output) =>
          extractMediaDelivery(
            extractAllMessageText(output) || this.serializeToolOutput(output)
          )
        );
      for (const discovered of [hiddenDelivery, ...toolDeliveries]) {
        for (const documentPath of discovered.documents) {
          if (!delivery.documents.includes(documentPath)) {
            delivery.documents.push(documentPath);
          }
        }
      }

      // Add assistant response to session
      this.sessions.addAssistantMessage(
        event.platform,
        event.chatId,
        delivery.text || responseText
      );

      // Send back to originating platform
      if (adapter) {
        if (delivery.text) {
          await this.deliverText(
            adapter,
            event,
            delivery.text,
            liveResult.streamedMessage
          );
        }

        for (const documentPath of delivery.documents) {
          console.log(
            `[Gateway] sending document to ${event.platform}:${event.chatId}: ${path.basename(documentPath)}`
          );
          await adapter.sendDocument(event.chatId, documentPath, {
            replyTo: event.id,
            fileName: path.basename(documentPath),
            mimeType: mimeTypeForDocument(documentPath),
          });
        }
      }
    } catch (err) {
      console.error("[Gateway] agent error:", err);
      if (adapter) {
        await adapter.sendMessage(
          event.chatId,
          "❌ Sorry, I encountered an error processing your request."
        );
      }
    }
  }

  private canStreamAgent(): boolean {
    return (
      !this.liveAgentStreamingDisabled &&
      typeof (this.agent as { stream?: unknown }).stream === "function"
    );
  }

  private isResetCommand(text: string): boolean {
    return /^\/(?:reset|new)(?:@[a-z0-9_]+)?$/i.test(text.trim());
  }

  private async withTypingIndicator<T>(
    adapter: BasePlatformAdapter | undefined,
    chatId: string,
    run: () => Promise<T>
  ): Promise<T> {
    const stopTyping = this.startTypingIndicator(adapter, chatId);
    try {
      return await run();
    } finally {
      stopTyping();
    }
  }

  private startTypingIndicator(
    adapter: BasePlatformAdapter | undefined,
    chatId: string
  ): () => void {
    if (!adapter) return () => undefined;

    const sendTyping = () => {
      adapter.sendChatAction(chatId, "typing").catch((err) => {
        console.warn("[Gateway] typing indicator failed:", err);
      });
    };

    sendTyping();
    const interval = setInterval(sendTyping, 4000);
    return () => clearInterval(interval);
  }

  private async invokeAgentWithLiveUpdates(
    messages: Array<{ role: string; content: string }>,
    event: MessageEvent,
    adapter: BasePlatformAdapter,
    callbacks: AgentTraceCallback[]
  ): Promise<LiveAgentResult> {
    const stopTyping = this.startTypingIndicator(adapter, event.chatId);
    let finalResult: unknown;
    let streamedMessage: SentMessageRef | undefined;
    let visibleText = "";
    let lastUpdateAt = 0;
    let lastUpdateLength = 0;
    const messageBuffers = new Map<string, string>();

    try {
      const stream = await (
        this.agent as unknown as {
          stream: (
            input: unknown,
            options: unknown
          ) => Promise<AsyncIterable<unknown>>;
        }
      ).stream(
        { messages },
        {
          streamMode: ["messages", "values"],
          callbacks,
        }
      );

      for await (const chunk of stream) {
        const parsed = this.parseStreamChunk(chunk);
        if (!parsed) continue;

        if (parsed.mode === "values") {
          finalResult = parsed.payload;
          continue;
        }

        if (parsed.mode !== "messages") continue;

        const messagePayload = Array.isArray(parsed.payload)
          ? parsed.payload[0]
          : undefined;
        const delta = this.extractMessageDelta(messagePayload, messageBuffers);
        if (!delta) continue;

        visibleText += delta;
        const now = Date.now();
        const shouldUpdate =
          !streamedMessage ||
          now - lastUpdateAt >= 1200 ||
          visibleText.length - lastUpdateLength >= 240;

        const liveText = extractMediaDelivery(visibleText).text;
        if (!shouldUpdate || !liveText.trim()) continue;

        streamedMessage = await adapter.sendMessageUpdate(
          event.chatId,
          this.formatLiveUpdateText(liveText),
          {
            replyTo: streamedMessage ? undefined : event.id,
            parseMode: "plain",
          },
          streamedMessage
        );
        lastUpdateAt = now;
        lastUpdateLength = visibleText.length;
      }
    } catch (err) {
      this.liveAgentStreamingDisabled = true;
      console.warn(
        "[Gateway] live agent streaming failed; falling back to invoke() for this and future requests:",
        this.errorMessage(err)
      );

      finalResult = await this.agent.invoke({ messages }, { callbacks });
    } finally {
      stopTyping();
    }

    return {
      result: finalResult ?? { messages: [{ content: visibleText }] },
      streamedMessage,
    };
  }

  private errorMessage(err: unknown): string {
    if (err instanceof Error) return err.message;
    return String(err);
  }

  private serializeToolOutput(output: unknown): string {
    if (typeof output === "string") return output;
    try {
      return JSON.stringify(output);
    } catch {
      return String(output);
    }
  }

  private parseStreamChunk(
    chunk: unknown
  ): { mode: string; payload: unknown } | undefined {
    if (!Array.isArray(chunk)) return undefined;

    if (typeof chunk[0] === "string") {
      return {
        mode: chunk[0],
        payload: chunk[1],
      };
    }

    if (Array.isArray(chunk[0]) && typeof chunk[1] === "string") {
      return {
        mode: chunk[1],
        payload: chunk[2],
      };
    }

    return undefined;
  }

  private extractMessageDelta(
    message: unknown,
    messageBuffers: Map<string, string>
  ): string {
    if (!message || typeof message !== "object") return "";

    const record = message as Record<string, unknown>;
    const messageType =
      typeof record._getType === "function"
        ? (record._getType as () => unknown)()
        : record.type;
    if (messageType !== "ai" && messageType !== "assistant") return "";

    const text = extractContentText(record.content);
    if (!text) return "";

    const id =
      typeof record.id === "string"
        ? record.id
        : `message-${messageBuffers.size + 1}`;
    const previous = messageBuffers.get(id) ?? "";
    const delta = text.startsWith(previous) ? text.slice(previous.length) : text;
    messageBuffers.set(id, previous + delta);
    return delta;
  }

  private formatLiveUpdateText(text: string): string {
    const maxLength = 3900;
    if (text.length <= maxLength) return text;
    return `${text.slice(0, maxLength)}\n\n...`;
  }

  private async deliverText(
    adapter: BasePlatformAdapter,
    event: MessageEvent,
    text: string,
    streamedMessage?: SentMessageRef
  ): Promise<void> {
    const chunks = this.chunkText(text, 4096);

    if (streamedMessage && adapter.supportsMessageUpdates()) {
      await adapter.sendMessageUpdate(
        event.chatId,
        chunks[0],
        { parseMode: "markdown" },
        streamedMessage
      );

      for (const chunk of chunks.slice(1)) {
        await adapter.sendMessage(event.chatId, chunk, {
          parseMode: "markdown",
        });
      }

      return;
    }

    await adapter.sendMessage(event.chatId, text, {
      replyTo: event.id,
      parseMode: "markdown",
    });
  }

  private chunkText(text: string, maxLength: number): string[] {
    if (text.length <= maxLength) return [text];
    const chunks: string[] = [];
    let remaining = text;
    while (remaining.length > 0) {
      let cutAt = remaining.lastIndexOf("\n", maxLength);
      if (cutAt <= 0) cutAt = maxLength;
      chunks.push(remaining.slice(0, cutAt));
      remaining = remaining.slice(cutAt).trimStart();
    }
    return chunks;
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
