import { createHash } from "node:crypto";
import { auth } from "./auth";
import { ensureDatabaseSchema } from "./db/migrate";

export async function getAuthSession(requestHeaders: Headers) {
  await ensureDatabaseSchema();
  return auth.api.getSession({ headers: requestHeaders });
}

/** Creates a stable UUID-shaped gateway workspace without exposing the user ID. */
export function workspaceIdForUser(userId: string): string {
  const bytes = createHash("sha256")
    .update(`bonte-crm-workspace:${userId}`)
    .digest()
    .subarray(0, 16);

  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");

  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}
