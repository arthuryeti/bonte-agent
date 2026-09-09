"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  useExternalStoreRuntime,
  type AppendMessage,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import { Thread } from "@/components/assistant-ui/elements/thread.aui";
import { ThreadList } from "@/components/assistant-ui/elements/thread-list.aui";
import { LeadResultsUI, PropertyResultsUI } from "@/components/crm-results";
import { Button } from "@/components/ui/button";
import { TooltipProvider } from "@/components/ui/tooltip";
import { MenuIcon, LogOutIcon, XIcon } from "lucide-react";
import { authClient } from "../lib/auth-client";
import {
  attachmentAdapter,
  requestJson,
  streamReply,
  toAssistantMessage,
  type ChatDocument,
} from "./assistant-adapter";
import type { CrmChatMessage } from "./chat-types";

type Chat = { id: string; title: string };
type User = { name: string; email: string };
const suggestions = [
  {
    title: "Find properties",
    label: "Search by location, budget and features",
    prompt: "Help me find available CRM properties that fit my requirements.",
  },
  {
    title: "Review leads",
    label: "Explore enquiries and contact history",
    prompt: "Show the latest CRM leads and help me filter their enquiry and contact history.",
  },
  {
    title: "Prepare an NDA",
    label: "Draft a confidentiality agreement",
    prompt: "Help me prepare an NDA using Bonte's template. Read any documents I attach and ask only for missing evidence or agreement terms.",
  },
  {
    title: "Prepare a CMI",
    label: "Draft a real estate mediation contract",
    prompt: "Help me prepare a CMI using Bonte's template. Read any documents I attach and ask only for missing evidence or commercial terms.",
  },
  {
    title: "Draft an email",
    label: "Prepare a message with property details",
    prompt: "Help me draft an email using verified property details and any attachments I select.",
  },
  {
    title: "Plan viewings",
    label: "Arrange property visits and check availability",
    prompt: "Help me plan property viewings, including dates, participants, meeting points and travel time. Start with a proposal and check calendar availability when the details are ready.",
  },
  {
    title: "Review documents",
    label: "Understand uploads and spot missing information",
    prompt: "Help me review my uploaded documents. Identify what they contain, summarize the relevant facts and flag missing or conflicting information. If there are no uploads yet, ask me to attach them.",
  },
  {
    title: "Match a buyer",
    label: "Search CRM and Idealista for a buyer",
    prompt: "Help me match a buyer across CRM and Idealista using their stated requirements or a saved buyer brief. Ask which lead or buyer brief to use.",
  },
  {
    title: "Manage buyer briefs",
    label: "Save requirements for future property matching",
    prompt: "Show my saved buyer briefs and help me create or update one with explicit requirements and preferences.",
  },
  {
    title: "Create a property brochure",
    label: "Generate a branded PDF for a listing",
    prompt: "Help me create a branded property PDF brochure from an exact CRM listing.",
  },
  {
    title: "Estimate an asking price",
    label: "Compare similar homes on the market",
    prompt: "Help me estimate a Portuguese home's sale asking price using comparable listings. Ask for the property reference, Idealista URL or missing property details before researching.",
  },
  {
    title: "Check a contact",
    label: "Look for an existing contact in lead history",
    prompt: "Help me check whether a contact already appears in CRM lead history using their email, phone or name.",
  },
  {
    title: "Register a lead",
    label: "Capture an enquiry and check for duplicates",
    prompt: "Help me register a new CRM lead. Collect the enquiry details and check for an existing contact before registration.",
  },
  {
    title: "Audit lead follow-ups",
    label: "Find enquiries that may need attention",
    prompt: "Audit CRM lead follow-ups and show which enquiries need attention, with the recorded evidence and any gaps in contact history.",
  },
  {
    title: "Manage follow-up tasks",
    label: "Create reminders or update existing tasks",
    prompt: "Show my Bonte follow-up tasks and help me create a reminder or update an existing task. Ask which action I want and collect a due time and timezone for new reminders.",
  },
  {
    title: "Monitor leads",
    label: "Set up recurring audits and notifications",
    prompt: "Help me set up a recurring lead audit in Bonte. Ask for the cadence and broker or source scope, and show any existing monitors first.",
  },
  {
    title: "Manage viewings",
    label: "Review, book, reschedule or cancel visits",
    prompt: "Show my saved viewing proposals and bookings, then ask which viewing and action I want help with.",
  },
  {
    title: "Report CRM outcomes",
    label: "Review won opportunities by broker and date",
    prompt: "Help me report CRM won-opportunity outcomes by closing date and broker. Ask for the period and scope, and explain any missing dates or attribution.",
  },
  {
    title: "Find a broker",
    label: "Look up CRM agents and contact details",
    prompt: "Help me find a CRM broker or agent and their verified contact details.",
  },
  {
    title: "Revisit saved drafts",
    label: "Continue editing emails, NDAs and CMIs",
    prompt: "Show the saved email, NDA and CMI drafts in this conversation and help me choose one to revise.",
  },
  {
    title: "View notifications",
    label: "Check reminders, audit findings and workflow status",
    prompt: "Show my saved Bonte notifications and the status of available workflows.",
  },
].map((suggestion) => ({
  ...suggestion,
  prompt: `${suggestion.prompt} Use the information already in this conversation, ask one focused question at a time for anything missing, and check any required setup before proceeding.`,
}));

export default function ChatPage({ user }: { user: User }) {
  const [chats, setChats] = useState<Chat[]>([]);
  const [sessionId, setSessionId] = useState("");
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const creating = useRef(false);

  function select(id: string) {
    setSessionId(id);
    try {
      localStorage.setItem("crm-assistant-session", id);
    } catch {
      /* Storage is optional. */
    }
  }

  async function newChat() {
    if (creating.current) return;
    creating.current = true;
    setError("");
    try {
      const { chat } = await requestJson<{ chat: Chat }>("/api/chats", {
        method: "POST",
      });
      setChats((current) => [chat, ...current]);
      select(chat.id);
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "Could not create a conversation.",
      );
    } finally {
      creating.current = false;
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    setError("");
    void requestJson<{ chats: Chat[] }>("/api/chats", {
      signal: controller.signal,
    })
      .then(async ({ chats }) => {
        if (controller.signal.aborted) return;
        setChats(chats);
        let saved = "";
        try {
          saved = localStorage.getItem("crm-assistant-session") || "";
        } catch {
          /* Storage is optional. */
        }
        if (chats.length)
          select(chats.find((chat) => chat.id === saved)?.id || chats[0].id);
        else {
          const { chat } = await requestJson<{ chat: Chat }>("/api/chats", {
            method: "POST",
            signal: controller.signal,
          });
          if (!controller.signal.aborted) {
            setChats([chat]);
            select(chat.id);
          }
        }
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          setError(
            error instanceof Error
              ? error.message
              : "Could not load conversations.",
          );
      });
    return () => controller.abort();
  }, [retry]);

  return (
    <TooltipProvider>
      <div className="flex h-dvh flex-col">
        {error && (
          <div
            role="alert"
            className="bg-destructive/10 text-destructive flex items-center justify-center gap-3 p-3 text-sm"
          >
            {error}
            <Button
              variant="outline"
              size="sm"
              onClick={() => setRetry((value) => value + 1)}
            >
              Retry
            </Button>
          </div>
        )}
        {sessionId ? (
          <ChatWorkspace
            key={sessionId}
            {...{ user, sessionId, chats, newChat, select }}
            onTitle={(title) =>
              setChats((current) =>
                current.map((chat) =>
                  chat.id === sessionId ? { ...chat, title } : chat,
                ),
              )
            }
          />
        ) : (
          !error && (
            <main
              role="status"
              className="grid h-dvh place-items-center text-sm text-muted-foreground"
            >
              Loading conversations…
            </main>
          )
        )}
      </div>
    </TooltipProvider>
  );
}

function ChatWorkspace({
  user,
  sessionId,
  chats,
  newChat,
  select,
  onTitle,
}: {
  user: User;
  sessionId: string;
  chats: Chat[];
  newChat: () => Promise<void>;
  select: (id: string) => void;
  onTitle: (title: string) => void;
}) {
  const router = useRouter();
  const [messages, setMessages] = useState<ThreadMessageLike[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [notice, setNotice] = useState("");
  const [running, setRunning] = useState(false);
  const [sidebar, setSidebar] = useState(false);
  const [tooManyAttachments, setTooManyAttachments] = useState(false);
  const [retry, setRetry] = useState(0);
  const lifetime = useRef(new AbortController());
  const turn = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    setLoading(true);
    setLoadError(false);
    setNotice("");
    void Promise.all([
      requestJson<{ messages: CrmChatMessage[] }>(
        `/api/chat?sessionId=${encodeURIComponent(sessionId)}`,
        { signal: controller.signal },
      ),
      requestJson<{ attachments: ChatDocument[] }>(
        `/api/attachments?sessionId=${encodeURIComponent(sessionId)}`,
        { signal: controller.signal },
      ),
    ])
      .then(([history, documents]) => {
        if (!controller.signal.aborted)
          setMessages(
            history.messages.map((message) =>
              toAssistantMessage(message, documents.attachments),
            ),
          );
      })
      .catch((error) => {
        if (!controller.signal.aborted) {
          setLoadError(true);
          setNotice(
            error instanceof Error
              ? error.message
              : "Could not load conversation.",
          );
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => {
      controller.abort();
      turn.current?.abort();
    };
  }, [sessionId, retry]);

  const attachments = useMemo(
    () =>
      attachmentAdapter(
        sessionId,
        () => lifetime.current.signal,
        setNotice,
      ),
    [sessionId],
  );

  async function onNew(message: AppendMessage) {
    if (turn.current || loading || loadError) return;
    const controller = new AbortController();
    turn.current = controller;
    const id = crypto.randomUUID();
    const text =
      message.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n")
        .trim() || "Please review the attached documents.";
    const attachmentIds = (message.attachments ?? []).map(
      (attachment) => attachment.id,
    );
    const userMessage: ThreadMessageLike = {
      ...message,
      id,
      content: [{ type: "text", text }],
    };
    let reply: ThreadMessageLike = {
      id: `assistant:${id}`,
      role: "assistant",
      content: [],
      status: { type: "running" },
    };
    const preceding = [...messages, userMessage];
    setMessages([...preceding, reply]);
    setRunning(true);
    setNotice("");
    if (!messages.length) onTitle(text.slice(0, 80));
    try {
      const wireMessage: CrmChatMessage = {
        id,
        role: "user",
        parts: [
          { type: "text", text },
          ...attachmentIds.map((attachmentId) => ({
            type: "data-source-document" as const,
            data: { attachmentId },
          })),
        ],
      };
      for await (const update of streamReply(
        sessionId,
        wireMessage,
        attachmentIds,
        controller.signal,
      )) {
        if (controller.signal.aborted) break;
        reply = {
          ...update,
          id: `assistant:${id}`,
          status: { type: "running" },
        };
        setMessages([...preceding, reply]);
      }
      reply = {
        ...reply,
        status: controller.signal.aborted
          ? { type: "incomplete", reason: "cancelled" }
          : { type: "complete", reason: "stop" },
      };
    } catch (error) {
      reply = {
        ...reply,
        status: controller.signal.aborted
          ? { type: "incomplete", reason: "cancelled" }
          : {
              type: "incomplete",
              reason: "error",
              error:
                error instanceof Error ? error.message : "The request failed.",
            },
      };
    } finally {
      setMessages([...preceding, reply]);
      setRunning(false);
      turn.current = null;
    }
  }

  const runtime = useExternalStoreRuntime<ThreadMessageLike>({
    messages,
    convertMessage: (message) => message,
    isRunning: running,
    isLoading: loading,
    isDisabled: loading || loadError,
    isSendDisabled: tooManyAttachments,
    suggestions,
    onNew,
    onCancel: async () => {
      turn.current?.abort();
    },
    adapters: {
      attachments,
      threadList: {
        threadId: sessionId,
        threads: chats.map((chat) => ({ ...chat, status: "regular" as const })),
        onSwitchToNewThread: newChat,
        onSwitchToThread: select,
      },
    },
  });

  useEffect(
    () =>
      runtime.thread.composer.unstable_on("attachmentAddError", (event) =>
        setNotice(event.message),
      ),
    [runtime],
  );
  useEffect(
    () =>
      runtime.thread.composer.subscribe(() =>
        setTooManyAttachments(
          runtime.thread.composer.getState().attachments.length > 12,
        ),
      ),
    [runtime],
  );

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <LeadResultsUI />
      <PropertyResultsUI />
      <div
        className="flex min-h-0 flex-1 bg-background text-foreground"
        onKeyDown={(event) => {
          if (event.key === "Escape") setSidebar(false);
        }}
      >
        {sidebar && (
          <button
            aria-label="Close conversations"
            className="fixed inset-0 z-20 bg-black/20 md:hidden"
            onClick={() => setSidebar(false)}
          />
        )}
        <aside
          id="conversations"
          aria-label="Conversations"
          className={`${sidebar ? "flex" : "hidden"} fixed inset-y-0 left-0 z-30 w-64 shrink-0 flex-col border-r bg-muted/40 p-3 backdrop-blur-xl md:static md:flex`}
        >
          <div className="mb-5 flex items-center justify-between px-2 py-3">
            <span className="font-semibold tracking-tight">Bonte</span>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Close conversations"
              className="md:hidden"
              onClick={() => setSidebar(false)}
            >
              <XIcon />
            </Button>
          </div>
          <nav className="min-h-0 flex-1 overflow-y-auto">
            <ThreadList />
          </nav>
          <div className="mt-4 flex items-center gap-2 border-t pt-4">
            <div className="min-w-0 flex-1 px-2 text-xs">
              <p className="truncate font-medium">{user.name}</p>
              <p className="truncate text-muted-foreground">{user.email}</p>
            </div>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Sign out"
              onClick={async () => {
                try {
                  const result = await authClient.signOut();
                  if (result.error) throw new Error(result.error.message);
                  router.replace("/login");
                  router.refresh();
                } catch {
                  setNotice("Could not sign out. Please try again.");
                }
              }}
            >
              <LogOutIcon />
            </Button>
          </div>
        </aside>
        <main className="flex min-w-0 flex-1 flex-col">
          <header className="flex min-h-14 flex-wrap items-center gap-3 border-b px-4 py-2 text-sm">
            <Button
              variant="ghost"
              size="icon"
              aria-label="Open conversations"
              aria-controls="conversations"
              aria-expanded={sidebar}
              className="md:hidden"
              onClick={() => setSidebar(true)}
            >
              <MenuIcon />
            </Button>
            <span className="flex-1 whitespace-nowrap font-medium">
              CRM Assistant
            </span>
          </header>
          {notice && (
            <div
              role="alert"
              className="flex items-center gap-3 border-b bg-muted px-4 py-2 text-sm"
            >
              <span className="flex-1">{notice}</span>
              {loadError && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setRetry((value) => value + 1)}
                >
                  Retry
                </Button>
              )}
              <Button
                variant="ghost"
                size="icon"
                aria-label="Dismiss notification"
                onClick={() => setNotice("")}
              >
                <XIcon />
              </Button>
            </div>
          )}
          {tooManyAttachments && (
            <p
              role="alert"
              className="border-b px-4 py-2 text-sm text-destructive"
            >
              Attach up to 12 documents per message. Remove a file to send.
            </p>
          )}
          <ComposerPrimitive.AttachmentDropzone className="group relative min-h-0 flex-1">
            <Thread />
            <div className="pointer-events-none absolute inset-3 z-10 hidden items-center justify-center rounded-2xl border-2 border-dashed border-ring bg-background/95 text-center group-data-[dragging=true]:flex">
              <p>
                Drop documents here
                <br />
                <span className="text-sm text-muted-foreground">
                  PDF, DOCX or images · up to 15 MB each
                </span>
              </p>
            </div>
          </ComposerPrimitive.AttachmentDropzone>
        </main>
      </div>
    </AssistantRuntimeProvider>
  );
}
