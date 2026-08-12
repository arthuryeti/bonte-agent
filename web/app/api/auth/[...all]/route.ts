import { toNextJsHandler } from "better-auth/next-js";
import { auth } from "../../../../lib/auth";
import { ensureDatabaseSchema } from "../../../../lib/db/migrate";

export const runtime = "nodejs";

const handlers = toNextJsHandler(auth);

export async function GET(request: Request) {
  await ensureDatabaseSchema();
  return handlers.GET(request);
}

export async function POST(request: Request) {
  await ensureDatabaseSchema();
  return handlers.POST(request);
}
