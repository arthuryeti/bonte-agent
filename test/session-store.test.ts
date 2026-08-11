import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { SessionStore } from "../src/gateway/session.js";
import type { MessageEvent } from "../src/gateway/types.js";

function userMessage(chatId: string, text: string): MessageEvent {
  return {
    id: randomUUID(),
    platform: "web",
    chatId,
    senderId: "browser-user",
    senderName: "Web user",
    text,
    timestamp: new Date(),
    isGroup: false,
  };
}

describe("gateway session storage", () => {
  it("indexes, titles, and clears in-memory sessions", async () => {
    const store = new SessionStore({ databaseUrl: "", databaseHost: "" });
    await store.connect();
    await store.ensureSession("web", "memory-chat");
    await store.addUserMessage(userMessage("memory-chat", "Show my newest CRM leads"));
    await store.addAssistantMessage("web", "memory-chat", "Here they are.");

    const recent = await store.listSessions("web");
    assert.equal(recent[0]?.id, "memory-chat");
    assert.equal(recent[0]?.title, "Show my newest CRM leads");
    assert.equal((await store.getMessages("web", "memory-chat")).length, 2);

    await store.clearSession("web", "memory-chat");
    assert.equal((await store.getMessages("web", "memory-chat")).length, 0);
    assert.equal((await store.listSessions("web"))[0]?.title, "New conversation");
    await store.close();
  });

  it(
    "retains chat messages and rich parts across PostgreSQL connections",
    { skip: !process.env.TEST_DATABASE_URL },
    async () => {
      const databaseUrl = process.env.TEST_DATABASE_URL!;
      const chatId = `postgres-${randomUUID()}`;
      const firstStore = new SessionStore({
        databaseUrl,
        databaseSsl: false,
        maxConnections: 2,
      });
      await firstStore.connect();
      await firstStore.addUserMessage(userMessage(chatId, "Remember this conversation"));
      await firstStore.addAssistantMessage(
        "web",
        chatId,
        "It is safely stored.",
        undefined,
        [{ type: "lead-list", id: "leads-1", data: { leads: [{ id: "42" }] } }],
      );
      await firstStore.close();

      const secondStore = new SessionStore({
        databaseUrl,
        databaseSsl: false,
        maxConnections: 2,
      });
      try {
        await secondStore.connect();
        const messages = await secondStore.getMessages("web", chatId);
        assert.deepEqual(
          messages.map(({ role, content }) => ({ role, content })),
          [
            { role: "user", content: "Remember this conversation" },
            { role: "assistant", content: "It is safely stored." },
          ],
        );
        assert.equal(messages[1]?.dataParts?.[0]?.id, "leads-1");
        assert.equal((await secondStore.listSessions("web")).some(
          (session) => session.id === chatId,
        ), true);
      } finally {
        await secondStore.close();
      }
    },
  );
});
