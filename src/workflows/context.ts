import { AsyncLocalStorage } from "node:async_hooks";

export interface WorkflowContext {
  workspaceId: string;
  conversationId: string;
  actorId: string;
  requestId?: string;
}

const contexts = new AsyncLocalStorage<WorkflowContext>();

export function getWorkflowContext(): WorkflowContext {
  const context = contexts.getStore();
  if (!context) throw new Error("An authenticated workflow context is required.");
  return context;
}

export function runWithWorkflowContext<T>(context: WorkflowContext, work: () => T): T {
  if (!context.workspaceId || !context.conversationId || !context.actorId) {
    throw new Error("Incomplete workflow identity.");
  }
  return contexts.run(Object.freeze({ ...context }), work);
}

/** Web IDs are assigned by the authenticated Next server, never by the model. */
export function workflowContextForMessage(event: {
  platform: string; chatId: string; senderId: string; id: string;
}): WorkflowContext {
  const workspaceId = event.platform === "web"
    ? event.chatId.split("_")[0]
    : `${event.platform}:${event.chatId}`;
  return {
    workspaceId,
    conversationId: event.chatId,
    actorId: event.platform === "web" ? workspaceId : event.senderId,
    requestId: event.id,
  };
}
