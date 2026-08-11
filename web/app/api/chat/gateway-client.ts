import WebSocket, { type RawData } from "ws";

export interface GatewayEvent<P = Record<string, unknown>> {
  type: string;
  session_id?: string;
  turn_id?: string;
  payload?: P;
}

interface JsonRpcFrame {
  id?: number | string | null;
  method?: string;
  params?: GatewayEvent;
  result?: unknown;
  error?: { message?: string };
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const CONNECT_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 15_000;

/** Small server-side JSON-RPC client for the long-running agent gateway. */
export class GatewayRpcClient {
  private socket?: WebSocket;
  private nextId = 0;
  private pending = new Map<number, PendingRequest>();
  private eventHandlers = new Set<(event: GatewayEvent) => void>();

  constructor(
    private readonly url: string,
    private readonly token?: string
  ) {}

  async connect(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(this.url, {
        headers: this.token ? { authorization: `Bearer ${this.token}` } : undefined,
      });
      this.socket = socket;
      let settled = false;

      const timer = setTimeout(() => finish(new Error("gateway connection timed out")), CONNECT_TIMEOUT_MS);
      const onAbort = () => finish(new DOMException("Aborted", "AbortError"));
      signal?.addEventListener("abort", onAbort, { once: true });

      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        socket.off("open", onOpen);
        socket.off("error", onError);
      };
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) {
          socket.terminate();
          reject(error);
        } else {
          resolve();
        }
      };
      const onOpen = () => {
        finish();
        socket.on("error", () =>
          this.rejectPending(new Error("agent gateway connection failed")),
        );
      };
      const onError = () => finish(new Error("could not connect to the agent gateway"));

      socket.on("open", onOpen);
      socket.on("error", onError);
      socket.on("message", (data) => this.handleMessage(data));
      socket.on("close", () => this.rejectPending(new Error("agent gateway disconnected")));
    });
  }

  onEvent(handler: (event: GatewayEvent) => void): () => void {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  request<T>(
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<T> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("agent gateway is not connected"));
    }
    if (signal?.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));

    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(id);
        reject(new DOMException("Aborted", "AbortError"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      const timer = setTimeout(() => {
        this.pending.delete(id);
        signal?.removeEventListener("abort", onAbort);
        reject(new Error(`gateway request timed out: ${method}`));
      }, REQUEST_TIMEOUT_MS);

      this.pending.set(id, {
        resolve: (value) => {
          signal?.removeEventListener("abort", onAbort);
          resolve(value as T);
        },
        reject: (error) => {
          signal?.removeEventListener("abort", onAbort);
          reject(error);
        },
        timer,
      });

      try {
        socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        signal?.removeEventListener("abort", onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  close(): void {
    this.socket?.close(1000, "request complete");
    this.socket = undefined;
    this.rejectPending(new Error("agent gateway connection closed"));
  }

  private handleMessage(data: RawData): void {
    let frame: JsonRpcFrame;
    try {
      frame = JSON.parse(data.toString()) as JsonRpcFrame;
    } catch {
      return;
    }

    if (frame.method === "event" && frame.params) {
      for (const handler of this.eventHandlers) handler(frame.params);
      return;
    }

    if (typeof frame.id !== "number") return;
    const pending = this.pending.get(frame.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(frame.id);

    if (frame.error) {
      pending.reject(new Error(frame.error.message || "gateway request failed"));
    } else {
      pending.resolve(frame.result);
    }
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
