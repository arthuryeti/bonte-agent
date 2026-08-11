"use client";

import { useChat } from "@ai-sdk/react";
import dynamic from "next/dynamic";
import {
  FormEvent,
  KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  CrmChatMessage,
  LeadView,
  ScheduleFollowUpAction,
} from "./chat-types";
import {
  LeadDrawer,
  LeadResults,
  type FollowUpValues,
} from "./lead-results";

const MarkdownMessage = dynamic(
  () => import("./markdown-message").then((module) => module.MarkdownMessage),
  { loading: () => <span className="markdown-loading-line" aria-hidden="true" /> }
);

const suggestions = [
  "Show me the latest leads",
  "Find available properties",
  "Which broker follow-ups are overdue?",
];

const SESSION_STORAGE_KEY = "crm-assistant-session";
const WORKSPACE_STORAGE_KEY = "crm-assistant-workspace";
const DEFAULT_CHAT_TITLE = "New conversation";
const MAX_RECENT_CHATS = 50;
const SESSION_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const WORKSPACE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface RecentChat {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

function createRecentChat(id = crypto.randomUUID()): RecentChat {
  const now = new Date().toISOString();
  return {
    id,
    title: DEFAULT_CHAT_TITLE,
    createdAt: now,
    updatedAt: now,
  };
}

function isRecentChat(value: unknown): value is RecentChat {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    SESSION_ID_PATTERN.test(record.id) &&
    typeof record.title === "string" &&
    typeof record.createdAt === "string" &&
    typeof record.updatedAt === "string"
  );
}

function sortRecentChats(chats: RecentChat[]): RecentChat[] {
  return [...chats]
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
    .slice(0, MAX_RECENT_CHATS);
}

async function requestNewChat(
  workspaceId: string,
  sessionId?: string,
): Promise<RecentChat> {
  const response = await fetch("/api/chats", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workspaceId, ...(sessionId ? { sessionId } : {}) }),
  });
  if (!response.ok) throw new Error("could not create chat");
  const body = await response.json() as { chat?: unknown };
  if (!isRecentChat(body.chat)) throw new Error("invalid chat response");
  return body.chat;
}

function titleFromMessage(message: string): string {
  const singleLine = message.replace(/\s+/g, " ").trim();
  if (singleLine.length <= 64) return singleLine;
  return `${singleLine.slice(0, 61).trimEnd()}…`;
}

function formatRecentTime(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const elapsed = Date.now() - date.getTime();
  if (elapsed < 60_000) return "Now";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h`;
  if (elapsed < 172_800_000) return "Yesterday";
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
  }).format(date);
}

export default function ChatPage() {
  const [input, setInput] = useState("");
  const [sessionId, setSessionId] = useState(() => crypto.randomUUID());
  const [workspaceId, setWorkspaceId] = useState(() => crypto.randomUUID());
  const [recentChats, setRecentChats] = useState<RecentChat[]>([]);
  const [hasLoadedWorkspace, setHasLoadedWorkspace] = useState(false);
  const [isLoadingChat, setIsLoadingChat] = useState(false);
  const [isCreatingChat, setIsCreatingChat] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [selectedLead, setSelectedLead] = useState<LeadView>();
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const { messages, sendMessage, setMessages, status, error, stop, clearError } =
    useChat<CrmChatMessage>();
  const isWorking = status === "submitted" || status === "streaming";
  const activeChat = useMemo(
    () => recentChats.find((chat) => chat.id === sessionId),
    [recentChats, sessionId]
  );

  useEffect(() => {
    let cancelled = false;
    const initialId = sessionId;
    const storedWorkspaceId = window.localStorage.getItem(WORKSPACE_STORAGE_KEY);
    const activeWorkspaceId = storedWorkspaceId && WORKSPACE_ID_PATTERN.test(storedWorkspaceId)
      ? storedWorkspaceId
      : workspaceId;
    window.localStorage.setItem(WORKSPACE_STORAGE_KEY, activeWorkspaceId);

    void (async () => {
      let chats: RecentChat[] = [];
      try {
        const response = await fetch(
          `/api/chats?workspaceId=${encodeURIComponent(activeWorkspaceId)}`,
        );
        if (!response.ok) throw new Error("could not load chats");
        const body = await response.json() as { chats?: unknown };
        if (Array.isArray(body.chats)) chats = body.chats.filter(isRecentChat);
        if (chats.length === 0) {
          chats = [await requestNewChat(activeWorkspaceId, initialId)];
        }
      } catch {
        chats = [createRecentChat(initialId)];
      }

      if (cancelled) return;
      const storedId = window.localStorage.getItem(SESSION_STORAGE_KEY);
      const activeId = storedId && chats.some((chat) => chat.id === storedId)
        ? storedId
        : chats[0].id;
      setWorkspaceId(activeWorkspaceId);
      setSessionId(activeId);
      setRecentChats(sortRecentChats(chats));
      setHasLoadedWorkspace(true);
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!hasLoadedWorkspace) return;
    window.localStorage.setItem(SESSION_STORAGE_KEY, sessionId);
  }, [hasLoadedWorkspace, sessionId]);

  useEffect(() => {
    if (!hasLoadedWorkspace) return;
    let cancelled = false;
    setIsLoadingChat(true);
    setMessages([]);

    void fetch(
      `/api/chat?sessionId=${encodeURIComponent(sessionId)}` +
        `&workspaceId=${encodeURIComponent(workspaceId)}`,
    )
      .then((response) => (response.ok ? response.json() : Promise.reject()))
      .then((body: { messages?: CrmChatMessage[] }) => {
        if (!cancelled && Array.isArray(body.messages)) setMessages(body.messages);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setIsLoadingChat(false);
      });

    return () => {
      cancelled = true;
    };
  }, [hasLoadedWorkspace, sessionId, setMessages, workspaceId]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, status]);

  const touchActiveChat = useCallback((message?: string) => {
    setRecentChats((current) => {
      const now = new Date().toISOString();
      const existing = current.find((chat) => chat.id === sessionId);
      const nextChat: RecentChat = {
        ...(existing ?? createRecentChat(sessionId)),
        title:
          message && (!existing || existing.title === DEFAULT_CHAT_TITLE)
            ? titleFromMessage(message)
            : existing?.title ?? DEFAULT_CHAT_TITLE,
        updatedAt: now,
      };
      return sortRecentChats([
        nextChat,
        ...current.filter((chat) => chat.id !== sessionId),
      ]);
    });
  }, [sessionId]);

  const submitMessage = useCallback((
    text: string,
    action?: ScheduleFollowUpAction
  ) => {
    const trimmedText = text.trim();
    if (!trimmedText || isWorking) return;

    clearError();
    touchActiveChat(trimmedText);
    void sendMessage(
      { text: trimmedText },
      { body: { sessionId, workspaceId, ...(action ? { action } : {}) } }
    );
    setInput("");
  }, [clearError, isWorking, sendMessage, sessionId, touchActiveChat, workspaceId]);

  const createNewChat = useCallback(async () => {
    if (messages.length === 0 && activeChat?.title === DEFAULT_CHAT_TITLE) {
      setSidebarOpen(false);
      return;
    }

    stop();
    clearError();
    setIsCreatingChat(true);
    try {
      const chat = await requestNewChat(workspaceId);
      setRecentChats((current) => sortRecentChats([chat, ...current]));
      setSessionId(chat.id);
      setMessages([]);
      setInput("");
      setSelectedLead(undefined);
      setSidebarOpen(false);
    } catch {
      const chat = createRecentChat();
      setRecentChats((current) => sortRecentChats([chat, ...current]));
      setSessionId(chat.id);
      setMessages([]);
      setInput("");
      setSelectedLead(undefined);
      setSidebarOpen(false);
    } finally {
      setIsCreatingChat(false);
    }
  }, [activeChat?.title, clearError, messages.length, setMessages, stop, workspaceId]);

  const selectChat = useCallback((chatId: string) => {
    if (chatId === sessionId) {
      setSidebarOpen(false);
      return;
    }
    stop();
    clearError();
    setMessages([]);
    setSessionId(chatId);
    setInput("");
    setSelectedLead(undefined);
    setSidebarOpen(false);
  }, [clearError, sessionId, setMessages, stop]);

  const closeLead = useCallback(() => setSelectedLead(undefined), []);

  const refreshLead = useCallback((lead: LeadView) => {
    closeLead();
    submitMessage(`Fetch the latest full CRM details for lead ID ${lead.id}.`);
  }, [closeLead, submitMessage]);

  const scheduleFollowUp = useCallback((
    lead: LeadView,
    values: FollowUpValues
  ) => {
    const date = new Date(values.scheduledFor);
    const readableDate = new Intl.DateTimeFormat("en-GB", {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(date);
    const contactName = lead.contact?.name || lead.title;
    const displayText = [
      `Schedule a follow-up for ${contactName} on ${readableDate}.`,
      values.note ? `Note: ${values.note}` : undefined,
    ].filter(Boolean).join(" ");

    closeLead();
    submitMessage(displayText, {
      actionId: crypto.randomUUID(),
      type: "schedule_follow_up",
      leadId: lead.id,
      leadTitle: lead.title,
      contactName: lead.contact?.name,
      scheduledFor: values.scheduledFor,
      note: values.note,
    });
  }, [closeLead, submitMessage]);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    submitMessage(input);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submitMessage(input);
    }
  };

  return (
    <main className="app-shell">
      <div className="workspace">
        {sidebarOpen ? (
          <button
            className="sidebar-overlay"
            type="button"
            aria-label="Close recent chats"
            onClick={() => setSidebarOpen(false)}
          />
        ) : null}

        <aside
          className={`chat-sidebar${sidebarOpen ? " open" : ""}`}
          id="recent-chats"
          aria-label="Recent chats"
        >
          <header className="sidebar-header">
            <div className="sidebar-brand">
              <span className="mark" aria-hidden="true">B</span>
              <div>
                <p className="title">CRM Assistant</p>
                <p>Bonte workspace</p>
              </div>
            </div>
            <button
              className="sidebar-close"
              type="button"
              onClick={() => setSidebarOpen(false)}
              aria-label="Close recent chats"
            >×</button>
          </header>

          <button
            className="sidebar-new-chat"
            type="button"
            onClick={createNewChat}
            disabled={!hasLoadedWorkspace || isCreatingChat}
          >
            <span aria-hidden="true">＋</span>
            New conversation
          </button>

          <div className="chat-history">
            <div className="chat-history-heading">
              <p>Recent</p>
              <span>{recentChats.length}</span>
            </div>
            <nav className="chat-history-list" aria-label="Conversation history">
              {recentChats.map((chat) => (
                <button
                  className={`chat-history-item${chat.id === sessionId ? " active" : ""}`}
                  type="button"
                  key={chat.id}
                  onClick={() => selectChat(chat.id)}
                  aria-current={chat.id === sessionId ? "page" : undefined}
                >
                  <span className="chat-item-icon" aria-hidden="true" />
                  <span className="chat-item-copy">
                    <strong>{chat.title}</strong>
                    <small>{formatRecentTime(chat.updatedAt)}</small>
                  </span>
                </button>
              ))}
            </nav>
          </div>

          <footer className="sidebar-footer">
            <span aria-hidden="true" />
            Agent gateway ready
          </footer>
        </aside>

        <section className="chat-panel" aria-label="CRM assistant chat">
          <header className="topbar">
            <div className="topbar-chat">
              <button
                className="sidebar-toggle"
                type="button"
                aria-controls="recent-chats"
                aria-expanded={sidebarOpen}
                aria-label="Open recent chats"
                onClick={() => setSidebarOpen(true)}
              >
                <i /><i /><i />
              </button>
              <div>
                <p className="title">{activeChat?.title || DEFAULT_CHAT_TITLE}</p>
                <p className="status"><span aria-hidden="true" /> Ready to help</p>
              </div>
            </div>
            <button
              className="new-chat"
              type="button"
              onClick={createNewChat}
              disabled={!hasLoadedWorkspace || isCreatingChat}
            >
              New chat
            </button>
          </header>

          <div className="conversation" aria-live="polite">
            <div className="conversation-content">
              {isLoadingChat || !hasLoadedWorkspace ? (
                <div className="chat-loading" aria-label="Loading conversation">
                  <i /><i /><i />
                </div>
              ) : messages.length === 0 ? (
                <div className="welcome">
                  <div className="welcome-mark" aria-hidden="true">B</div>
                  <h1>How can I help?</h1>
                  <p>Ask about your leads, properties, agencies, or follow-ups.</p>
                  <div className="suggestions">
                    {suggestions.map((suggestion) => (
                      <button
                        key={suggestion}
                        type="button"
                        onClick={() => submitMessage(suggestion)}
                      >
                        {suggestion}
                        <span aria-hidden="true">↗</span>
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="messages">
                  {messages.map((message) => {
                    const hasLeadResults = message.parts.some(
                      (part) => part.type === "data-lead-list"
                    );
                    return (
                      <article
                        className={`message ${message.role}${hasLeadResults ? " has-rich-result" : ""}`}
                        key={message.id}
                      >
                        <div className="message-label">
                          {message.role === "user" ? "You" : "Assistant"}
                        </div>
                        <div className="bubble">
                          {message.parts.map((part, index) => {
                            if (part.type === "text") {
                              return part.text ? (
                                message.role === "assistant" ? (
                                  <MarkdownMessage
                                    content={part.text}
                                    key={`${message.id}-text-${index}`}
                                  />
                                ) : (
                                  <p key={`${message.id}-text-${index}`}>{part.text}</p>
                                )
                              ) : null;
                            }
                            if (part.type === "data-lead-list") {
                              return (
                                <LeadResults
                                  data={part.data}
                                  key={part.id || `${message.id}-leads-${index}`}
                                  onSelect={setSelectedLead}
                                />
                              );
                            }
                            return null;
                          })}
                        </div>
                      </article>
                    );
                  })}
                  {status === "submitted" ? (
                    <article className="message assistant thinking" aria-label="Assistant is thinking">
                      <div className="message-label">Assistant</div>
                      <div className="bubble"><i /><i /><i /></div>
                    </article>
                  ) : null}
                </div>
              )}

              {error ? (
                <div className="error" role="alert">
                  <span>Something went wrong. Please try again.</span>
                  <button type="button" onClick={clearError}>Dismiss</button>
                </div>
              ) : null}
              <div ref={messagesEndRef} />
            </div>
          </div>

          <div className="composer-wrap">
            <div className="composer-inner">
              <form className="composer" onSubmit={handleSubmit}>
                <textarea
                  aria-label="Message the CRM assistant"
                  placeholder="Ask anything about your CRM…"
                  rows={1}
                  value={input}
                  onChange={(event) => setInput(event.target.value)}
                  onKeyDown={handleKeyDown}
                  disabled={isWorking || isLoadingChat}
                />
                {isWorking ? (
                  <button className="send stop" type="button" onClick={stop} aria-label="Stop response">
                    <span aria-hidden="true" />
                  </button>
                ) : (
                  <button className="send" type="submit" disabled={!input.trim() || isLoadingChat} aria-label="Send message">
                    <span aria-hidden="true">↑</span>
                  </button>
                )}
              </form>
              <p className="hint">Enter to send · Shift + Enter for a new line</p>
            </div>
          </div>
        </section>
      </div>

      {selectedLead ? (
        <LeadDrawer
          lead={selectedLead}
          disabled={isWorking}
          onClose={closeLead}
          onRefresh={refreshLead}
          onSchedule={scheduleFollowUp}
        />
      ) : null}
    </main>
  );
}
