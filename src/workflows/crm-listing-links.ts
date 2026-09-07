import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { canonicalProperty, type VerifiedListingMapping } from "./crm-properties.js";
import { record, string, number, type CrmRecord } from "./crm-common.js";

export interface ListingSourceConfig { sourceUrl: string; allowedHosts: string[]; maxPages?: number; maxSourceDocuments?: number }
export interface WebsiteResponse { url: string; body: string; contentType?: string }
export type WebsiteReader = (url: string, allowedHosts: string[]) => Promise<WebsiteResponse>;

export function assertAllowedWebsiteUrl(value: string, allowedHosts: string[]): URL {
  const url = new URL(value);
  const hostname = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) throw new Error("Listing sources must use HTTPS without credentials or custom ports.");
  if (isIP(hostname) || hostname.includes(":") || hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) throw new Error("Listing sources must use an allowed public hostname.");
  if (!allowedHosts.map((host) => host.trim().toLowerCase()).includes(hostname)) throw new Error(`Listing host ${hostname} is not in CRM_LISTING_ALLOWED_HOSTS.`);
  return url;
}

const nonPublicIpv6 = new BlockList();
for (const [address, prefix] of [["2001:db8::", 32], ["2001::", 32], ["2001:10::", 28], ["2001:20::", 28], ["2002::", 16]] as const) nonPublicIpv6.addSubnet(address, prefix, "ipv6");
export function isPublicWebsiteAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 6) return /^[23][0-9a-f]{3}:/i.test(address) && !nonPublicIpv6.check(address, "ipv6");
  if (family !== 4) return false;
  const [a, b, c] = address.split(".").map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
    || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113));
}

/** Resolve and pin a public IP so a DNS change cannot redirect a fetch to a private service. */
export const readAllowedWebsite: WebsiteReader = async (initialUrl, allowedHosts) => {
  let url = assertAllowedWebsiteUrl(initialUrl, allowedHosts);
  for (let redirects = 0; redirects <= 4; redirects++) {
    const addresses = await lookup(url.hostname, { all: true, verbatim: true });
    if (!addresses.length || addresses.some((address) => !isPublicWebsiteAddress(address.address))) throw new Error("Listing hostname resolves to a non-public address.");
    const pinned = addresses[0];
    const response = await new Promise<{ status: number; location?: string; contentType?: string; body: string }>((fulfill, reject) => {
      const request = httpsRequest(url, {
        method: "GET", timeout: 15_000, maxHeaderSize: 32_768,
        headers: { Accept: "text/html,application/json,application/xml,text/xml", "User-Agent": "Bonte-verified-listing-sync/1.0" },
        lookup: (_hostname, options, callback) => {
          if (options.all) callback(null, [{ address: pinned.address, family: pinned.family }]);
          else callback(null, pinned.address, pinned.family);
        },
      }, (incoming) => {
        const chunks: Buffer[] = []; let bytes = 0;
        incoming.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 2_000_000) { request.destroy(new Error("Listing source exceeds the 2 MB response limit.")); return; }
          chunks.push(chunk);
        });
        incoming.on("error", reject);
        incoming.on("end", () => fulfill({ status: incoming.statusCode ?? 0, location: incoming.headers.location, contentType: incoming.headers["content-type"], body: Buffer.concat(chunks).toString("utf8") }));
      });
      request.on("timeout", () => request.destroy(new Error("Listing source request timed out.")));
      const deadline = setTimeout(() => request.destroy(new Error("Listing source exceeded the total request deadline.")), 15_000);
      request.on("close", () => clearTimeout(deadline));
      request.on("error", reject);
      request.end();
    });
    if (response.status >= 300 && response.status < 400 && response.location) {
      url = assertAllowedWebsiteUrl(new URL(response.location, url).href, allowedHosts); continue;
    }
    if (response.status !== 200) throw new Error(`Listing source returned HTTP ${response.status}.`);
    return { url: url.href, body: response.body, contentType: response.contentType };
  }
  throw new Error("Listing source exceeded four redirects.");
};

function decodeHtml(value: string): string {
  return value.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_match, digits: string) => { const n = Number(digits); return n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : ""; });
}
function attributes(tag: string): Record<string, string> {
  return Object.fromEntries([...tag.matchAll(/([\w:-]+)\s*=\s*(["'])(.*?)\2/gs)].map((match) => [match[1].toLowerCase(), decodeHtml(match[3]).trim()]));
}

/** Accept explicit listing identity fields only. A mention in surrounding prose, similar slug, or title is not identity evidence. */
export function extractListingIdentity(html: string): { references: string[]; propertyIds: number[]; canonicalUrl?: string } {
  html = html.replace(/<!--[\s\S]*?-->/g, " ").replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ").replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ");
  const references = new Set<string>(), propertyIds = new Set<number>(); let canonicalUrl: string | undefined;
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attrs = attributes(match[0]); const key = (attrs.name ?? attrs.property ?? "").toLowerCase();
    if (["property-reference", "property:reference", "listing-reference", "listing:reference"].includes(key) && attrs.content) references.add(attrs.content);
    if (["casafari-property-id", "casafari:property_id", "crm-property-id"].includes(key) && /^\d+$/.test(attrs.content ?? "")) propertyIds.add(Number(attrs.content));
  }
  for (const match of html.matchAll(/<link\b[^>]*>/gi)) { const attrs = attributes(match[0]); if (attrs.rel?.toLowerCase() === "canonical" && attrs.href) canonicalUrl = attrs.href; }
  const visible = decodeHtml(html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ").replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ");
  for (const match of visible.matchAll(/(?:^|\s)(?:Property reference|Listing reference|Reference|Referência|Referencia|Ref\.?)\s*:\s*([A-Za-z0-9][A-Za-z0-9._/-]*)(?=\s|$)/gi)) references.add(match[1]);
  return { references: [...references], propertyIds: [...propertyIds], canonicalUrl };
}

export function verifyListingPage(html: string, property: CrmRecord): { verified: boolean; reason: string } {
  const known = canonicalProperty(property); const identity = extractListingIdentity(html);
  const expectedReference = string(known.reference), expectedId = number(known.propertyId);
  if (identity.references.length > 1 || identity.propertyIds.length > 1) return { verified: false, reason: "Page contains multiple listing identities." };
  if (identity.references.length && identity.references[0] !== expectedReference) return { verified: false, reason: "Page reference does not match the CRM reference." };
  if (identity.propertyIds.length && identity.propertyIds[0] !== expectedId) return { verified: false, reason: "Page property ID does not match the CRM property ID." };
  if (!identity.references.length && !identity.propertyIds.length) return { verified: false, reason: "Page has no explicit CRM reference or property ID evidence." };
  return { verified: true, reason: "Exact page identity matches the CRM property." };
}

interface Candidate { url: string; reference?: string; propertyId?: number }
function feedCandidates(body: string): Candidate[] | undefined {
  try {
    const data = JSON.parse(body); const items = Array.isArray(data) ? data : record(data).listings;
    if (!Array.isArray(items)) throw new Error("JSON listing feed must be an array or contain a listings array.");
    return items.map((item) => { const value = record(item); if (!string(value.url)) throw new Error("Listing feed entry is missing url."); return { url: String(value.url), reference: string(value.reference), propertyId: number(value.propertyId) }; });
  } catch (error) { if (error instanceof SyntaxError) return undefined; throw error; }
}

export async function buildVerifiedListingMappings(config: ListingSourceConfig, properties: CrmRecord[], read: WebsiteReader = readAllowedWebsite) {
  assertAllowedWebsiteUrl(config.sourceUrl, config.allowedHosts);
  const maxPages = Math.min(10_000, Math.max(1, config.maxPages ?? 1_000));
  const maxSourceDocuments = Math.min(100, Math.max(1, config.maxSourceDocuments ?? 20));
  const candidates: Candidate[] = [], sourceQueue = [config.sourceUrl], visitedSources = new Set<string>();
  const warnings: string[] = []; let truncated = false;
  while (sourceQueue.length && visitedSources.size < maxSourceDocuments) {
    const source = sourceQueue.shift()!; if (visitedSources.has(source)) continue;
    visitedSources.add(source); assertAllowedWebsiteUrl(source, config.allowedHosts);
    const document = await read(source, config.allowedHosts);
    assertAllowedWebsiteUrl(document.url, config.allowedHosts);
    const feed = feedCandidates(document.body);
    if (feed) candidates.push(...feed);
    else {
      const urls = [...document.body.matchAll(/<loc(?:\s[^>]*)?>([\s\S]*?)<\/loc>/gi)].map((match) => decodeHtml(match[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").trim()));
      if (!urls.length) throw new Error("Source is neither a supported JSON feed nor a sitemap with loc entries.");
      if (/<sitemapindex\b/i.test(document.body)) sourceQueue.push(...urls);
      else candidates.push(...urls.map((url) => ({ url })));
    }
    if (candidates.length >= maxPages) { if (candidates.length > maxPages || sourceQueue.length) truncated = true; break; }
  }
  if (sourceQueue.length) truncated = true;
  const verified: VerifiedListingMapping[] = [], rejected: { url: string; reason: string }[] = [];
  const known = properties.map(canonicalProperty); const seenUrls = new Set<string>();
  for (const candidate of candidates.slice(0, maxPages)) {
    if (seenUrls.has(candidate.url)) continue; seenUrls.add(candidate.url);
    try {
      assertAllowedWebsiteUrl(candidate.url, config.allowedHosts);
      const page = await read(candidate.url, config.allowedHosts); assertAllowedWebsiteUrl(page.url, config.allowedHosts);
      const identity = extractListingIdentity(page.body);
      const matching = known.filter((property) => {
        if (candidate.reference && candidate.reference !== property.reference) return false;
        if (candidate.propertyId !== undefined && candidate.propertyId !== property.propertyId) return false;
        return verifyListingPage(page.body, property).verified;
      });
      if (matching.length !== 1) throw new Error(matching.length ? "Page maps to multiple CRM properties." : "No exact CRM identity verified on page.");
      let canonical = page.url;
      if (identity.canonicalUrl) {
        canonical = assertAllowedWebsiteUrl(new URL(identity.canonicalUrl, page.url).href, config.allowedHosts).href;
        // A canonical URL may point elsewhere; verify that destination too.
        if (canonical !== page.url) {
          const canonicalPage = await read(canonical, config.allowedHosts); assertAllowedWebsiteUrl(canonicalPage.url, config.allowedHosts);
          if (!verifyListingPage(canonicalPage.body, matching[0]).verified) throw new Error("Canonical destination does not match the CRM property.");
          canonical = canonicalPage.url;
        }
      }
      verified.push({ propertyId: number(matching[0].propertyId), reference: string(matching[0].reference), url: canonical, verifiedAt: new Date().toISOString() });
    } catch (error) { rejected.push({ url: candidate.url, reason: error instanceof Error ? error.message : "Page verification failed" }); }
  }
  const groups = new Map<string, VerifiedListingMapping[]>();
  for (const entry of verified) { const key = `${entry.propertyId}:${entry.reference}`; groups.set(key, [...(groups.get(key) ?? []), entry]); }
  const mappings: VerifiedListingMapping[] = [];
  for (const entries of groups.values()) {
    if (new Set(entries.map((entry) => entry.url)).size === 1) mappings.push(entries[0]);
    else warnings.push(`Multiple verified canonical URLs for ${entries[0].reference}; mapping withheld for review.`);
  }
  return { mappings, rejected, warnings, coverage: { sourceDocuments: visitedSources.size, candidatePages: candidates.length, checkedPages: seenUrls.size, truncated } };
}

export async function writeVerifiedListingMappings(path: string, mappings: VerifiedListingMapping[]): Promise<void> {
  const output = resolve(path); await mkdir(dirname(output), { recursive: true });
  const temporary = `${output}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(mappings, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, output);
}
