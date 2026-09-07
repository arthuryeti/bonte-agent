import "dotenv/config";
import { unlink } from "node:fs/promises";
import path from "node:path";
import { createCrmAgent } from "./agent.js";
import { Gateway } from "./gateway/gateway.js";
import { WebAdapter } from "./gateway/platforms/web.js";
import { GatewayWebSocketServer } from "./gateway/websocket-server.js";
import type { GatewayConfig } from "./gateway/types.js";
import { describeResolvedProvider } from "./providers/factory.js";
import { logAiEvent } from "./observability.js";
import { initializeWorkflowStore } from "./workflows/store.js";
import { WorkflowWorker } from "./workflows/tasks.js";
import { fetchAllLeads, queryLeads, auditLeads } from "./workflows/crm-leads.js";
import { purgeExpiredAttachments } from "./workflows/documents-attachments.js";

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
 *  - DATABASE_URL          → PostgreSQL connection string (required in production)
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
    platforms.push({ platform: "web" });
  }

  // Telegram
  if (process.env.TELEGRAM_BOT_TOKEN) {
    platforms.push({
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
  const workflowStore = await initializeWorkflowStore();
  const worker = new WorkflowWorker(workflowStore, async (_scope, filters) => {
    const query: import("./workflows/crm-leads.js").LeadQuery = { broker: typeof filters.agentName === "string" ? filters.agentName : undefined, origin: typeof filters.origin === "string" ? filters.origin : undefined,
      category: filters.category === "Sales" || filters.category === "Listings" ? filters.category : undefined };
    const dataset = await fetchAllLeads(query);
    const report = auditLeads({ ...dataset, leads: queryLeads(dataset, query) }, {
      ...(typeof filters.firstResponseHours === "number" ? {firstResponseHours:filters.firstResponseHours}:{}),
      ...(typeof filters.inactivityHours === "number" ? {inactivityHours:filters.inactivityHours}:{}),
    });
    return { coverage: report.coverage, counts: report.counts, denominator: report.denominator,
      findings: report.attentionCandidates.map(f => ({leadId:f.leadId,classification:f.classification,reason:f.reason,status:f.status})).sort((a,b)=>String(a.leadId).localeCompare(String(b.leadId))) };
  }, async () => {
    const now = new Date().toISOString();
    const expired = (await Promise.all(["attachment", "nda-intake", "nda-draft", "email-draft"].map(kind => workflowStore.expired(kind, now, 100)))).flat();
    for (const scope of new Set(expired.map(row => row.workspaceId))) await purgeExpiredAttachments(scope);
    for (const kind of ["audit_run", "notification", "generated_file"]) {
      for (const row of await workflowStore.expired(kind, now, 100)) {
        if (kind === "generated_file" && path.basename(row.id) === row.id) {
          await unlink(path.resolve("output/pdf", row.id)).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
        }
        await workflowStore.remove(row.workspaceId, kind, row.id);
      }
    }
  });

  const agent = createCrmAgent("gateway");
  console.log(`[LLM] ${describeResolvedProvider()}`);
  logAiEvent("info", "gateway.starting", {
    provider: process.env.LLM_PROVIDER || "unknown",
    model: process.env.LLM_MODEL || "unknown",
  });

  const gateway = new Gateway(agent, config);
  await gateway.start();
  worker.start();

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
    await worker.stop();
    await webServer?.stop();
    await gateway.stop();
    await workflowStore.close();
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
