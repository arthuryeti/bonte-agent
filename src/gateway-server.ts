import "dotenv/config";
import { createCrmAgent } from "./agent.js";
import { Gateway } from "./gateway/gateway.js";
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
 *
 *  Plus all LLM_PROVIDER / CRM auth vars from .env.example
 */

function buildConfig(): GatewayConfig {
  const platforms: GatewayConfig["platforms"] = [];

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
      },
    });
  }

  return {
    platforms,
    resetPolicy: "after_minutes",
    resetAfterMinutes: parseInt(process.env.SESSION_RESET_MINUTES || "60", 10),
  };
}

async function main() {
  const config = buildConfig();

  if (config.platforms.length === 0) {
    console.error(
      "No messaging platforms configured.\n" +
        "Set TELEGRAM_BOT_TOKEN and/or WHATSAPP_ENABLED=true in your .env"
    );
    process.exit(1);
  }

  const agent = createCrmAgent("gateway");
  console.log(`[LLM] ${describeResolvedProvider()}`);

  const gateway = new Gateway(agent, config);
  await gateway.start();

  // Status log every 30s
  const statusInterval = setInterval(() => {
    const status = gateway.status();
    console.log("[Status]", JSON.stringify(status));
  }, 30000);

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`\n${signal} received, shutting down...`);
    clearInterval(statusInterval);
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
