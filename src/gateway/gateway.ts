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
import { WebAdapter } from "./platforms/web.js";
import { SessionStore, type RecentChatSession } from "./session.js";
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
import {
  extractCrmToolError,
  normalizeLeadListToolOutput,
  normalizePropertyListToolOutput,
  type LeadListView,
  type PropertyListView,
} from "./crm-ui.js";
import { TurnDeliveryLedger } from "./turn-delivery-ledger.js";
import type {
  GatewayConfig,
  MessageEvent,
  Platform,
  PlatformConfig,
  SentMessageRef,
} from "./types.js";

interface LiveAgentResult {
  result: unknown;
  deliveryLedger?: TurnDeliveryLedger;
}

class AgentTraceCallback extends BaseCallbackHandler {
  name = "AgentTraceCallback";
  private toolRuns = new Map<string, string>();
  private documentToolOutputs: unknown[] = [];
  private leadListOutputs: LeadListView[] = [];
  private propertyListOutputs: PropertyListView[] = [];

  constructor(
    private readonly webAdapter?: WebAdapter,
    private readonly chatId?: string
  ) {
    super();
  }

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
    if (this.webAdapter && this.chatId) {
      this.webAdapter.publishToolStart(this.chatId, {
        run_id: runId,
        tool_name: toolName,
        endpoint: toolName === "call_crm_api"
          ? this.crmEndpoint(input)
          : undefined,
      });
    }

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

    if (toolName === "call_crm_api") {
      const crmError = extractCrmToolError(output);
      if (crmError) {
        if (process.env.DEEPAGENT_TOOL_LOGS === "true") {
          console.warn(`[DeepAgent] tool failed: ${toolName}: ${crmError}`);
        }
        if (this.webAdapter && this.chatId) {
          this.webAdapter.publishToolError(this.chatId, {
            run_id: runId,
            tool_name: toolName,
            message: crmError,
          });
        }
        this.toolRuns.delete(runId);
        return;
      }

      const leadList = normalizeLeadListToolOutput(output);
      if (leadList) {
        this.leadListOutputs.push(leadList);
        if (this.webAdapter && this.chatId) {
          this.webAdapter.publishLeadList(this.chatId, leadList, runId);
        }
      }

      const propertyList = normalizePropertyListToolOutput(output);
      if (propertyList) {
        this.propertyListOutputs.push(propertyList);
        if (this.webAdapter && this.chatId) {
          this.webAdapter.publishPropertyList(this.chatId, propertyList, runId);
        }
      }
    }

    if (toolName === "task") {
      console.log("[DeepAgent] sub-agent completed");
    } else if (process.env.DEEPAGENT_TOOL_LOGS === "true") {
      console.log(`[DeepAgent] tool completed: ${toolName}`);
    }

    if (this.webAdapter && this.chatId) {
      this.webAdapter.publishToolComplete(this.chatId, {
        run_id: runId,
        tool_name: toolName,
      });
    }

    this.toolRuns.delete(runId);
  }

  getDocumentToolOutputs(): readonly unknown[] {
    return this.documentToolOutputs;
  }

  getLeadListOutputs(): readonly LeadListView[] {
    return this.leadListOutputs;
  }

  getPropertyListOutputs(): readonly PropertyListView[] {
    return this.propertyListOutputs;
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

    if (toolName && this.webAdapter && this.chatId) {
      this.webAdapter.publishToolError(this.chatId, {
        run_id: runId,
        tool_name: toolName,
        message: this.errorMessage(err),
      });
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

  private crmEndpoint(input: string): string | undefined {
    const parsed = this.parseInput(input);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    const endpoint = (parsed as Record<string, unknown>).endpoint;
    return typeof endpoint === "string" ? endpoint : undefined;
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
  name: "web",
  label: "Web",
  factory: () => new WebAdapter(),
  requiredEnv: [],
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
      mode: cfg.mode as "bot" | "self-chat" | undefined,
      replyPrefix: cfg.replyPrefix as string | undefined,
      forwardOwnerMessages: cfg.forwardOwnerMessages as boolean | undefined,
      handoverMinutes: cfg.handoverMinutes as number | undefined,
      sendReadReceipts: cfg.sendReadReceipts as boolean | undefined,
      streamUpdates: cfg.streamUpdates as boolean | undefined,
      maxMessageLength: cfg.maxMessageLength as number | undefined,
    }),
  requiredEnv: [], // WhatsApp uses file-based auth, no env key needed
});

export class Gateway {
  private adapters = new Map<string, BasePlatformAdapter>();
  private sessions: SessionStore;
  private agent: DeepAgent;
  private config: GatewayConfig;
  private purgeInterval?: NodeJS.Timeout;
  private liveAgentStreamingDisabled = false;
  private activeTurns = new Map<string, AbortController>();

  constructor(
    agent: DeepAgent,
    config: GatewayConfig,
    sessions: SessionStore = new SessionStore()
  ) {
    this.agent = agent;
    this.config = config;
    this.sessions = sessions;
  }

  async start(): Promise<void> {
    console.log("[Gateway] starting...");
    await this.sessions.connect();

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
        void this.sessions
          .purgeIdle(this.config.resetAfterMinutes!)
          .then((purged) => {
            if (purged > 0) {
              console.log(`[Gateway] purged ${purged} idle sessions`);
            }
          })
          .catch((error) => {
            console.error("[Gateway] failed to purge idle sessions:", error);
          });
      }, Math.min(ms, 60000)); // Check at most every minute
    }

    console.log(`[Gateway] running with ${this.adapters.size} platform(s)`);
  }

  async stop(): Promise<void> {
    console.log("[Gateway] stopping...");
    for (const controller of this.activeTurns.values()) controller.abort();
    this.activeTurns.clear();
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
    await this.sessions.close();
  }

  private async handleMessage(event: MessageEvent): Promise<void> {
    console.log(
      `[Gateway] ${event.platform}:${event.chatId} <${event.senderName}>: ${event.text.slice(0, 80)}`
    );

    const adapter = this.adapters.get(event.platform);
    if (event.fromOwner) {
      await this.sessions.addAssistantMessage(
        event.platform,
        event.chatId,
        event.text,
        event.id
      );
      console.log(
        `[Gateway] human handover started for ${event.platform}:${event.chatId}`
      );
      return;
    }

    if (event.handoverActive) {
      await this.sessions.addUserMessage(event);
      console.log(
        `[Gateway] bot response suppressed during human handover for ${event.platform}:${event.chatId}`
      );
      return;
    }

    if (this.isResetCommand(event.text)) {
      await this.sessions.clearSession(event.platform, event.chatId);
      if (adapter) {
        await adapter.sendMessage(
          event.chatId,
          "Conversation reset. I’ll use a fresh context for your next request.",
          { replyTo: event.id }
        );
      }
      return;
    }

    const turnKey = this.sessionKey(event.platform, event.chatId);
    if (this.activeTurns.has(turnKey)) {
      if (adapter) {
        await adapter.sendMessage(
          event.chatId,
          "I’m still working on the previous request. Stop it before sending another message."
        );
      }
      return;
    }
    const abortController = new AbortController();
    this.activeTurns.set(turnKey, abortController);

    // Add user message to session history
    await this.sessions.addUserMessage(event);

    // Build message array from session history
    const history = await this.sessions.getMessages(event.platform, event.chatId);
    const messages = history.map((m) => ({
      role: m.role,
      content: m.content,
    }));
    if (event.agentText && messages.length > 0) {
      messages[messages.length - 1] = {
        ...messages[messages.length - 1],
        content: event.agentText,
      };
    }

    const traceCallback = new AgentTraceCallback(
      adapter instanceof WebAdapter ? adapter : undefined,
      event.chatId
    );
    const callbacks = [traceCallback];
    let requestStage = "agent invocation";

    try {
      const liveResult: LiveAgentResult =
        adapter?.supportsMessageUpdates() && this.canStreamAgent()
          ? await this.invokeAgentWithLiveUpdates(
              messages,
              event,
              adapter,
              callbacks,
              abortController.signal
            )
          : {
              result: await this.withTypingIndicator(adapter, event.chatId, () =>
                this.agent.invoke(
                  { messages },
                  { callbacks, signal: abortController.signal }
                )
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
        for (const media of discovered.media) {
          if (!delivery.media.some((item) => item.filePath === media.filePath)) {
            delivery.media.push(media);
          }
        }
        for (const location of discovered.locations) {
          if (
            !delivery.locations.some(
              (item) =>
                item.latitude === location.latitude &&
                item.longitude === location.longitude
            )
          ) {
            delivery.locations.push(location);
          }
        }
      }

      if (
        !delivery.text.trim() &&
        delivery.documents.length === 0 &&
        delivery.media.length === 0 &&
        delivery.locations.length === 0
      ) {
        delivery.text =
          "I couldn’t produce a usable response. Please try again; if this was a CRM request, check the CRM connection logs.";
      }
      console.log(
        `[Gateway] agent completed for ${event.platform}:${event.chatId} ` +
          `(text=${delivery.text.length}, documents=${delivery.documents.length}, ` +
          `media=${delivery.media.length}, locations=${delivery.locations.length})`
      );

      // Add assistant response to session
      await this.sessions.addAssistantMessage(
        event.platform,
        event.chatId,
        delivery.text || responseText,
        event.id ? `assistant:${event.id}` : undefined,
        [
          ...traceCallback.getLeadListOutputs().map((data) => ({
            type: "lead-list" as const,
            id: data.id,
            data,
          })),
          ...traceCallback.getPropertyListOutputs().map((data) => ({
            type: "property-list" as const,
            id: data.id,
            data,
          })),
        ]
      );

      // Send back to originating platform
      requestStage = "response delivery";
      if (adapter) {
        if (delivery.text) {
          await this.deliverText(
            adapter,
            event,
            delivery.text,
            liveResult.deliveryLedger
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

        for (const media of delivery.media) {
          console.log(
            `[Gateway] sending ${media.type} to ${event.platform}:${event.chatId}: ${path.basename(media.filePath)}`
          );
          await adapter.sendMedia(event.chatId, media.filePath, media.type, {
            replyTo: event.id,
            fileName: path.basename(media.filePath),
            mimeType: media.mimeType,
            voice: media.voice,
            gifPlayback: media.gifPlayback,
          });
        }

        for (const location of delivery.locations) {
          console.log(
            `[Gateway] sending location to ${event.platform}:${event.chatId}`
          );
          await adapter.sendLocation(
            event.chatId,
            location.latitude,
            location.longitude,
            {
              replyTo: event.id,
              name: location.name,
              address: location.address,
            }
          );
        }

        console.log(
          `[Gateway] response delivered to ${event.platform}:${event.chatId}`
        );
      }
    } catch (err) {
      if (abortController.signal.aborted) {
        console.log(`[Gateway] turn stopped for ${event.platform}:${event.chatId}`);
        return;
      }
      console.error(`[Gateway] ${requestStage} error:`, err);
      if (adapter) {
        await adapter.sendMessage(
          event.chatId,
          "❌ Sorry, I encountered an error processing your request."
        );
      }
    } finally {
      if (this.activeTurns.get(turnKey) === abortController) {
        this.activeTurns.delete(turnKey);
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
    callbacks: AgentTraceCallback[],
    signal: AbortSignal
  ): Promise<LiveAgentResult> {
    const stopTyping = this.startTypingIndicator(adapter, event.chatId);
    let finalResult: unknown;
    let streamedMessage: SentMessageRef | undefined;
    let lastUpdateAt = 0;
    let lastUpdateLength = 0;
    const messageBuffers = new Map<string, string>();
    const deliveryLedger = new TurnDeliveryLedger();

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
          signal,
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
        const messageDelta = this.extractMessageDelta(
          messagePayload,
          messageBuffers
        );
        if (!messageDelta) continue;

        deliveryLedger.recordStreamDelta(
          messageDelta.messageId,
          messageDelta.delta
        );
        const visibleText = deliveryLedger.streamText;
        const now = Date.now();
        const shouldUpdate =
          !streamedMessage ||
          now - lastUpdateAt >= adapter.liveUpdateIntervalMs() ||
          visibleText.length - lastUpdateLength >= adapter.liveUpdateMinChars();

        const liveText = extractMediaDelivery(visibleText).text;
        if (!shouldUpdate || !liveText.trim()) continue;

        const deliveredText = this.formatLiveUpdateText(liveText);
        streamedMessage = await adapter.sendMessageUpdate(
          event.chatId,
          deliveredText,
          {
            replyTo: streamedMessage ? undefined : event.id,
            parseMode: "plain",
          },
          streamedMessage
        );
        if (streamedMessage) {
          deliveryLedger.recordStreamDelivery(deliveredText, streamedMessage);
        }
        lastUpdateAt = now;
        lastUpdateLength = visibleText.length;
      }
    } catch (err) {
      if (signal.aborted) throw err;
      this.liveAgentStreamingDisabled = true;
      console.warn(
        "[Gateway] live agent streaming failed; falling back to invoke() for this and future requests:",
        this.errorMessage(err)
      );

      finalResult = await this.agent.invoke(
        { messages },
        { callbacks, signal }
      );
    } finally {
      stopTyping();
    }

    return {
      result: finalResult ?? {
        messages: [{ content: deliveryLedger.streamText }],
      },
      deliveryLedger,
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
  ): { messageId: string; delta: string } | undefined {
    if (!message || typeof message !== "object") return undefined;

    const record = message as Record<string, unknown>;
    const messageType =
      typeof record._getType === "function"
        ? (record._getType as () => unknown)()
        : record.type;
    if (messageType !== "ai" && messageType !== "assistant") return undefined;

    const text = extractContentText(record.content);
    if (!text) return undefined;

    const id =
      typeof record.id === "string"
        ? record.id
        : `message-${messageBuffers.size + 1}`;
    const previous = messageBuffers.get(id) ?? "";
    const delta = text.startsWith(previous) ? text.slice(previous.length) : text;
    messageBuffers.set(id, previous + delta);
    return delta ? { messageId: id, delta } : undefined;
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
    deliveryLedger?: TurnDeliveryLedger
  ): Promise<void> {
    const chunks = this.chunkText(text, 4096);
    const streamedMessage = deliveryLedger?.messageRef;

    if (streamedMessage && adapter.supportsMessageUpdates()) {
      const finalAlreadyVisible =
        deliveryLedger.deliveredFinalMatches(text) === true;
      const finalUpdateText = finalAlreadyVisible
        ? deliveryLedger.acknowledgedText
        : chunks[0];
      const finalRef = await adapter.sendMessageUpdate(
        event.chatId,
        finalUpdateText,
        { parseMode: "markdown" },
        streamedMessage
      );

      if (!finalAlreadyVisible) {
        for (const chunk of chunks.slice(1)) {
          await adapter.sendMessage(event.chatId, chunk, {
            parseMode: "markdown",
          });
        }
      }

      deliveryLedger.recordFinalDelivery(text, finalRef ?? streamedMessage);
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
    out.storage = this.sessions.isPersistent ? "postgresql" : "memory";
    return out;
  }

  getAdapter<T extends BasePlatformAdapter = BasePlatformAdapter>(
    platform: Platform
  ): T | undefined {
    return this.adapters.get(platform) as T | undefined;
  }

  async getSessionMessages(platform: Platform, chatId: string) {
    return (await this.sessions.getMessages(platform, chatId)).map((message) => ({
      role: message.role,
      content: message.content,
      platform_message_id: message.platformMessageId,
      timestamp: message.timestamp.toISOString(),
      data_parts: message.dataParts ?? [],
    }));
  }

  async hasSessionMessage(
    platform: Platform,
    chatId: string,
    platformMessageId: string
  ): Promise<boolean> {
    return this.sessions.hasMessage(platform, chatId, platformMessageId);
  }

  async ensureSession(
    platform: Platform,
    chatId: string
  ): Promise<RecentChatSession> {
    const session = await this.sessions.ensureSession(platform, chatId);
    return {
      id: session.chatId,
      title: session.title,
      createdAt: session.createdAt.toISOString(),
      updatedAt: session.lastActivity.toISOString(),
    };
  }

  async listSessions(
    platform: Platform,
    limit?: number,
    chatIdPrefix?: string
  ): Promise<RecentChatSession[]> {
    return this.sessions.listSessions(platform, limit, chatIdPrefix);
  }

  async clearSession(platform: Platform, chatId: string): Promise<void> {
    await this.sessions.clearSession(platform, chatId);
  }

  stopSession(platform: Platform, chatId: string): boolean {
    const controller = this.activeTurns.get(this.sessionKey(platform, chatId));
    if (!controller) return false;
    controller.abort();
    return true;
  }

  private sessionKey(platform: Platform, chatId: string): string {
    return `${platform}:${chatId}`;
  }
}
