import "dotenv/config";
import { createCrmAgent } from "./agent.js";
import { Gateway } from "./gateway/gateway.js";
import { WebAdapter } from "./gateway/platforms/web.js";
import { GatewayWebSocketServer } from "./gateway/websocket-server.js";
import type { GatewayConfig } from "./gateway/types.js";
import { describeResolvedProvider } from "./providers/factory.js";

/**
 * Gateway server entry point.
 *
 * Starts the DeepAgent with a messaging gateway that listens on
 * Telegram and/or WhatsApp.
 *
 * Environment variables:
 *  - TELEGRAM_BOT_TOKEN    → required for Telegram
 *  - TELEGRAM_ALLOWED_USERS→ optional comma-separated user IDs
 *  - WHATSAPP_AUTH_DIR     → optional auth state directory (default: .whatsapp-auth)
 *  - WHATSAPP_MODE         → bot (default) or self-chat
 *  - DATABASE_URL          → optional PostgreSQL connection string for durable chats
 *
 *  Plus all LLM_PROVIDER / CRM auth vars from .env.example
 */

function buildConfig(): GatewayConfig {
  const platforms: GatewayConfig["platforms"] = [];
  const resetAfterMinutes = parseInt(
    process.env.SESSION_RESET_MINUTES || "0",
    10
  );

  if (process.env.WEB_GATEWAY_ENABLED !== "false") {
    platforms.push({ enabled: true, platform: "web" });
  }

  // Telegram
  if (process.env.TELEGRAM_BOT_TOKEN) {
    platforms.push({
      enabled: true,
      platform: "telegram",
      extra: {
        botToken: process.env.TELEGRAM_BOT_TOKEN,
        allowedUsers: process.env.TELEGRAM_ALLOWED_USERS
          ? process.env.TELEGRAM_ALLOWED_USERS.split(",").map((s) => s.trim())
          : undefined,
        requireMention: process.env.TELEGRAM_REQUIRE_MENTION === "true",
        typingIndicator: process.env.TELEGRAM_TYPING_INDICATOR !== "false",
        streamUpdates: process.env.TELEGRAM_STREAM_UPDATES !== "false",
      },
    });
  }

  // WhatsApp
  if (process.env.WHATSAPP_ENABLED === "true") {
    platforms.push({
      enabled: true,
      platform: "whatsapp",
      extra: {
        authDir: process.env.WHATSAPP_AUTH_DIR || ".whatsapp-auth",
        allowFrom: process.env.WHATSAPP_ALLOW_FROM
          ? process.env.WHATSAPP_ALLOW_FROM.split(",").map((s) => s.trim())
          : undefined,
        allowGroups: process.env.WHATSAPP_ALLOW_GROUPS
          ? process.env.WHATSAPP_ALLOW_GROUPS.split(",").map((s) => s.trim())
          : undefined,
        requireMention: process.env.WHATSAPP_REQUIRE_MENTION === "true",
        debug: process.env.WHATSAPP_DEBUG === "true",
        sendTimeoutMs: parseInt(
          process.env.WHATSAPP_SEND_TIMEOUT_MS || "60000",
          10
        ),
        chunkDelayMs: parseInt(
          process.env.WHATSAPP_CHUNK_DELAY_MS || "300",
          10
        ),
        mode:
          process.env.WHATSAPP_MODE === "self-chat" ? "self-chat" : "bot",
        replyPrefix:
          !process.env.WHATSAPP_REPLY_PREFIX
            ? undefined
            : process.env.WHATSAPP_REPLY_PREFIX === "none"
              ? ""
              : process.env.WHATSAPP_REPLY_PREFIX.replace(/\\n/g, "\n"),
        forwardOwnerMessages:
          process.env.WHATSAPP_FORWARD_OWNER_MESSAGES === "true",
        handoverMinutes: parseInt(
          process.env.WHATSAPP_HANDOVER_MINUTES || "60",
          10
        ),
        sendReadReceipts:
          process.env.WHATSAPP_SEND_READ_RECEIPTS === "true",
        streamUpdates: process.env.WHATSAPP_STREAM_UPDATES !== "false",
        maxMessageLength: parseInt(
          process.env.WHATSAPP_MAX_MESSAGE_LENGTH || "4096",
          10
        ),
      },
    });
  }

  return {
    platforms,
    resetPolicy: resetAfterMinutes > 0 ? "after_minutes" : "never",
    resetAfterMinutes: resetAfterMinutes > 0 ? resetAfterMinutes : undefined,
  };
}

async function main() {
  const config = buildConfig();

  const agent = createCrmAgent("gateway");
  console.log(`[LLM] ${describeResolvedProvider()}`);

  const gateway = new Gateway(agent, config);
  await gateway.start();

  let webServer: GatewayWebSocketServer | undefined;
  const webAdapter = gateway.getAdapter<WebAdapter>("web");
  if (webAdapter) {
    webServer = new GatewayWebSocketServer(gateway, webAdapter, {
      host: process.env.GATEWAY_WEB_HOST || "127.0.0.1",
      port: parseInt(process.env.GATEWAY_WEB_PORT || "8787", 10),
      token: process.env.GATEWAY_WEB_TOKEN,
    });
    await webServer.start();
  }

  // Status log every 30s
  const statusInterval = setInterval(() => {
    const status = gateway.status();
    console.log("[Status]", JSON.stringify(status));
  }, 30000);

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`\n${signal} received, shutting down...`);
    clearInterval(statusInterval);
    await webServer?.stop();
    await gateway.stop();
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
