import fs from "node:fs";
import path from "node:path";

export async function clearWhatsAppAuthState(authDir: string): Promise<void> {
  const resolvedAuthDir = path.resolve(authDir);
  const root = path.parse(resolvedAuthDir).root;
  const workingDirectory = path.resolve(process.cwd());

  if (resolvedAuthDir === root || resolvedAuthDir === workingDirectory) {
    throw new Error(
      `Refusing to clear unsafe WhatsApp auth directory: ${resolvedAuthDir}`
    );
  }

  let entries: string[];
  try {
    entries = await fs.promises.readdir(resolvedAuthDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      await fs.promises.mkdir(resolvedAuthDir, { recursive: true });
      return;
    }
    throw err;
  }

  await Promise.all(
    entries.map((entry) =>
      fs.promises.rm(path.join(resolvedAuthDir, entry), {
        recursive: true,
        force: true,
      })
    )
  );
}

export function normalizeWhatsAppIdentifier(value: unknown): string {
  return String(value || "")
    .trim()
    .replace(/:.*@/, "@")
    .replace(/@.*/, "")
    .replace(/^\+/, "");
}

function readMappingFile(
  authDir: string,
  identifier: string,
  suffix = ""
): string | undefined {
  if (!/^[a-zA-Z0-9._-]+$/.test(identifier)) return undefined;

  const filePath = path.join(
    authDir,
    `lid-mapping-${identifier}${suffix}.json`
  );
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return normalizeWhatsAppIdentifier(parsed) || undefined;
  } catch {
    return undefined;
  }
}

export function expandWhatsAppIdentifiers(
  identifier: unknown,
  authDir: string
): Set<string> {
  const normalized = normalizeWhatsAppIdentifier(identifier);
  if (!normalized) return new Set();

  const resolved = new Set<string>();
  const queue = [normalized];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || resolved.has(current)) continue;
    resolved.add(current);

    for (const suffix of ["", "_reverse"]) {
      const mapped = readMappingFile(authDir, current, suffix);
      if (mapped && !resolved.has(mapped)) queue.push(mapped);
    }
  }
  return resolved;
}

function normalizePhoneJid(value: unknown): string | undefined {
  const jid = String(value || "").trim();
  const identifier = normalizeWhatsAppIdentifier(jid);
  if (!identifier) return undefined;
  if (jid.endsWith("@s.whatsapp.net")) {
    return `${identifier}@s.whatsapp.net`;
  }
  if (jid.endsWith("@hosted")) return `${identifier}@hosted`;
  return undefined;
}

/**
 * Prefer the phone-number address for a direct chat received as a LID.
 *
 * Baileys exposes the alternate PN address on v7 message keys. Sending a
 * response back to the raw `@lid` can leave the recipient with "Waiting for
 * this message" while the outgoing pre-key session is closed. Groups and
 * already-PN chats retain their original address.
 */
export function resolveWhatsAppChatId(msg: any, authDir: string): string {
  const remoteJid = String(msg?.key?.remoteJid || "");
  if (
    !remoteJid ||
    remoteJid.endsWith("@g.us") ||
    remoteJid.endsWith("@broadcast") ||
    (!remoteJid.endsWith("@lid") &&
      !remoteJid.endsWith("@hosted.lid"))
  ) {
    return remoteJid;
  }

  for (const candidate of [
    msg?.key?.remoteJidAlt,
    msg?.key?.senderPn,
    msg?.senderPn,
  ]) {
    const phoneJid = normalizePhoneJid(candidate);
    if (phoneJid) return phoneJid;
  }

  const lidIdentifier = normalizeWhatsAppIdentifier(remoteJid);
  for (const alias of expandWhatsAppIdentifiers(remoteJid, authDir)) {
    if (alias && alias !== lidIdentifier) {
      return `${alias}@s.whatsapp.net`;
    }
  }

  return remoteJid;
}

/**
 * Match phone JIDs and v7 LIDs transparently. An empty allowlist preserves
 * this project's existing allow-all behavior; use a concrete list to lock it
 * down, or `*` to make the open policy explicit.
 */
export function matchesWhatsAppAllowlist(
  identifiers: unknown[],
  allowlist: string[] | undefined,
  authDir: string
): boolean {
  if (!allowlist?.length) return true;

  const allowed = new Set(
    allowlist.map(normalizeWhatsAppIdentifier).filter(Boolean)
  );
  if (allowed.has("*")) return true;

  for (const identifier of identifiers) {
    for (const alias of expandWhatsAppIdentifiers(identifier, authDir)) {
      if (allowed.has(alias)) return true;
    }
  }
  return false;
}

export function getWhatsAppMessageContent(msg: any): Record<string, any> {
  let content = msg?.message || {};
  for (let depth = 0; depth < 4; depth += 1) {
    const wrapped =
      content.ephemeralMessage?.message ||
      content.viewOnceMessage?.message ||
      content.viewOnceMessageV2?.message ||
      content.documentWithCaptionMessage?.message;
    if (!wrapped) break;
    content = wrapped;
  }
  return content;
}

export function getWhatsAppContextInfo(
  messageContent: Record<string, any>
): Record<string, any> {
  for (const value of Object.values(messageContent || {})) {
    if (value && typeof value === "object" && value.contextInfo) {
      return value.contextInfo;
    }
  }
  return {};
}

export interface BoundedMessageStore {
  remember(message: any): void;
  get(id: string | undefined): any | undefined;
}

export interface BoundedIdTracker {
  remember(id: string | undefined): void;
  has(id: string | undefined): boolean;
}

export function createBoundedIdTracker(limit = 512): BoundedIdTracker {
  const ids = new Set<string>();
  return {
    remember(id: string | undefined): void {
      if (!id) return;
      ids.delete(id);
      ids.add(id);
      while (ids.size > limit) {
        const oldest = ids.values().next().value;
        if (oldest === undefined) break;
        ids.delete(oldest);
      }
    },
    has(id: string | undefined): boolean {
      return Boolean(id && ids.has(id));
    },
  };
}

export interface HandoverTracker {
  activate(chatId: string): void;
  isActive(chatId: string): boolean;
  clear(chatId: string): void;
}

export function createHandoverTracker(
  ttlMs: number,
  now: () => number = Date.now
): HandoverTracker {
  const handovers = new Map<string, number>();
  return {
    activate(chatId: string): void {
      if (!chatId || ttlMs <= 0) return;
      handovers.set(chatId, now() + ttlMs);
    },
    isActive(chatId: string): boolean {
      const expiresAt = handovers.get(chatId);
      if (!expiresAt) return false;
      if (expiresAt <= now()) {
        handovers.delete(chatId);
        return false;
      }
      return true;
    },
    clear(chatId: string): void {
      handovers.delete(chatId);
    },
  };
}

export function isWhatsAppSelfChat(
  jid: unknown,
  sock: any,
  authDir?: string
): boolean {
  const chatIdentifier = normalizeWhatsAppIdentifier(jid);
  if (!chatIdentifier) return false;

  const chatAliases = authDir
    ? expandWhatsAppIdentifiers(chatIdentifier, authDir)
    : new Set([chatIdentifier]);
  for (const ownIdentifier of [sock?.user?.id, sock?.user?.lid]) {
    const ownAliases = authDir
      ? expandWhatsAppIdentifiers(ownIdentifier, authDir)
      : new Set([normalizeWhatsAppIdentifier(ownIdentifier)].filter(Boolean));
    if ([...ownAliases].some((identifier) => chatAliases.has(identifier))) {
      return true;
    }
  }
  return false;
}

/** Remove invisible control characters and normalize unusual spaces. */
export function sanitizeWhatsAppText(text: string): string {
  return text
    .replace(/[\u200B\u2060\u2063\uFEFF]/g, "")
    .replace(/[\u00A0\u2007\u202F]/g, " ");
}

/** Convert common Markdown into WhatsApp's lightweight formatting syntax. */
export function formatWhatsAppText(text: string): string {
  const protectedSegments: string[] = [];
  const protectedText = sanitizeWhatsAppText(text).replace(
    /```[\s\S]*?```|`[^`\n]+`/g,
    (segment) => {
      const token = `\uE000${protectedSegments.length}\uE001`;
      protectedSegments.push(segment);
      return token;
    }
  );

  const formatted = protectedText
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, "$1 ($2)")
    .replace(/(?<![*\w])\*([^*\n]+)\*(?!\*)/g, "_$1_")
    .replace(/\*\*([^*\n]+)\*\*/g, "*$1*")
    .replace(/__([^_\n]+)__/g, "*$1*")
    .replace(/~~([^~\n]+)~~/g, "~$1~")
    .replace(/^\s{0,3}#{1,6}\s+(.+?)\s*#*$/gm, "*$1*");

  return formatted.replace(/\uE000(\d+)\uE001/g, (_match, index: string) => {
    return protectedSegments[Number(index)] || "";
  });
}

export function createBoundedMessageStore(limit = 512): BoundedMessageStore {
  const messages = new Map<string, any>();
  return {
    remember(message: any): void {
      const id = message?.key?.id;
      if (!id) return;
      messages.delete(id);
      messages.set(id, message);
      while (messages.size > limit) {
        const oldest = messages.keys().next().value;
        if (oldest === undefined) break;
        messages.delete(oldest);
      }
    },
    get(id: string | undefined): any | undefined {
      if (!id) return undefined;
      const message = messages.get(id);
      if (!message) return undefined;
      messages.delete(id);
      messages.set(id, message);
      return message;
    },
  };
}

export interface SerialQueue {
  enqueue<T>(operation: () => Promise<T>): Promise<T>;
}

export function createSerialQueue(): SerialQueue {
  let tail: Promise<void> = Promise.resolve();
  return {
    enqueue<T>(operation: () => Promise<T>): Promise<T> {
      const task = tail.then(operation, operation);
      tail = task.then(
        () => undefined,
        () => undefined
      );
      return task;
    },
  };
}

export function createWhatsAppVersionResolver(
  fetchVersion: () => Promise<{ version?: readonly number[] }>,
  options: {
    timeoutMs?: number;
    log?: (message: string) => void;
  } = {}
): () => Promise<readonly number[] | undefined> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const log = options.log ?? console.warn;
  let cachedVersion: readonly number[] | undefined;

  return async () => {
    let timer: NodeJS.Timeout | undefined;
    try {
      const result = await Promise.race([
        fetchVersion(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("version fetch timed out")),
            timeoutMs
          );
        }),
      ]);
      if (result.version?.length) cachedVersion = [...result.version];
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(
        `[WhatsApp] version fetch failed (${message}); using ${
          cachedVersion ? "cached version" : "the library default"
        }`
      );
    } finally {
      if (timer) clearTimeout(timer);
    }
    return cachedVersion;
  };
}

export function splitWhatsAppMessage(
  text: string,
  maxLength = 4096
): string[] {
  if (!text) return [];
  if (text.length <= maxLength) return [text];

  const preserveCodeFences = text.includes("```") && maxLength >= 128;
  const chunkLimit = preserveCodeFences ? maxLength - 64 : maxLength;
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > chunkLimit) {
    let cutAt = remaining.lastIndexOf("\n", chunkLimit);
    if (cutAt < Math.floor(chunkLimit / 2)) {
      cutAt = remaining.lastIndexOf(" ", chunkLimit);
    }
    if (cutAt < 1) cutAt = chunkLimit;
    chunks.push(remaining.slice(0, cutAt).trimEnd());
    remaining = remaining.slice(cutAt).trimStart();
  }
  if (remaining) chunks.push(remaining);
  if (!preserveCodeFences) return chunks;

  let inCodeFence = false;
  let openingFence = "```";
  return chunks.map((chunk) => {
    const prefix = inCodeFence ? `${openingFence.slice(0, 48)}\n` : "";
    for (const marker of chunk.match(/```[^\n]*/g) || []) {
      if (inCodeFence) {
        inCodeFence = false;
      } else {
        inCodeFence = true;
        openingFence = marker;
      }
    }
    const suffix = inCodeFence ? "\n```" : "";
    return `${prefix}${chunk}${suffix}`;
  });
}
