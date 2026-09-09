import { record, type CrmRecord } from "./crm-common.js";

const HOST = "idealista17.p.rapidapi.com";

export function idealistaListingUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !["idealista.pt", "www.idealista.pt"].includes(url.hostname) || url.port || url.username || url.password
      || !/^\/(?:[a-z]{2}\/)?imovel\/[1-9]\d*\/?$/.test(url.pathname)) return undefined;
    url.hostname = "www.idealista.pt";
    url.pathname = url.pathname.replace(/^\/[a-z]{2}\//, "/").replace(/\/?$/, "/");
    url.search = ""; url.hash = "";
    return url.href;
  } catch { return undefined; }
}

export async function idealistaGet(path: "/auto-complete" | "/property-search" | "/property-details-by-url", params: Record<string, string | number>, signal?: AbortSignal): Promise<CrmRecord> {
  const key = process.env.RAPIDAPI_KEY?.trim();
  if (!key) throw new Error("Idealista is not configured. Set RAPIDAPI_KEY on the gateway and subscribe to Happy Endpoint's Idealista API.");
  const url = new URL(`https://${HOST}${path}`);
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, String(value));
  const timeout = AbortSignal.timeout(20_000);
  let response: Response;
  try {
    response = await fetch(url, { headers: { "X-RapidAPI-Key": key, "X-RapidAPI-Host": HOST, Accept: "application/json" },
      redirect: "error", signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  } catch {
    throw new Error(signal?.aborted ? "Idealista request was cancelled." : "Idealista request failed or timed out. Try again later.");
  }
  if (!response.ok) {
    const message = response.status === 401 || response.status === 403 ? "Check RAPIDAPI_KEY and the Happy Endpoint Idealista subscription."
      : response.status === 429 ? "RapidAPI quota or rate limit reached. Try again after the limit resets."
      : response.status === 404 || response.status === 410 ? "The listing or location is unavailable."
      : "The Idealista provider could not complete this request. Try again later.";
    throw new Error(`Idealista request failed (${response.status}). ${message}`);
  }
  let body: CrmRecord;
  try { body = record(await response.json()); } catch { throw new Error("Idealista returned malformed JSON."); }
  if (body.success !== true || !body.data || typeof body.data !== "object" || Array.isArray(body.data)) throw new Error("Idealista returned an unsuccessful or invalid response.");
  return record(body.data);
}

