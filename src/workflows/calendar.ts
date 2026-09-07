import { createHash, randomUUID } from "node:crypto";

/** Provider contract: https://developers.google.com/workspace/calendar/api/v3/reference */
export interface CalendarScope { workspaceId: string; actorId: string; conversationId: string }
interface RecordValue<T> { id: string; data: T; version: number }
export interface CalendarStore {
  get<T>(scope: string, kind: string, id: string): Promise<RecordValue<T> | null>;
  create<T>(scope: string, kind: string, id: string, data: T): Promise<boolean>;
  list<T>(scope: string, kind: string, limit?: number): Promise<RecordValue<T>[]>;
  compareAndSet<T>(scope: string, kind: string, id: string, version: number, data: T): Promise<boolean>;
}
export interface CalendarConfig {
  workspaceId?: string;
  workspaceIds?: string[];
  authorizedActorIds: string[];
  allowedCalendarIds: string[];
  accessToken?: string;
  clientId?: string;
  clientSecret?: string;
  refreshToken?: string;
  timeoutMs?: number;
}
export function calendarConfigFromEnv(env = process.env): CalendarConfig {
  const values = (key: string) => (env[key] ?? "").split(",").map(s => s.trim()).filter(Boolean);
  return {
    workspaceId: env.GOOGLE_CALENDAR_WORKSPACE_ID,
    workspaceIds: values("GOOGLE_CALENDAR_WORKSPACE_IDS"),
    authorizedActorIds: values("GOOGLE_CALENDAR_AUTHORIZED_ACTOR_IDS"),
    allowedCalendarIds: values("GOOGLE_CALENDAR_ALLOWED_IDS"),
    accessToken: env.GOOGLE_CALENDAR_ACCESS_TOKEN,
    clientId: env.GOOGLE_CALENDAR_CLIENT_ID,
    clientSecret: env.GOOGLE_CALENDAR_CLIENT_SECRET,
    refreshToken: env.GOOGLE_CALENDAR_REFRESH_TOKEN,
    timeoutMs: 15_000,
  };
}
export interface ViewingSlot {
  propertyId: number;
  reference: string;
  title: string;
  location: string;
  start: string;
  end: string;
  timeZone: string;
  notes?: string;
  travelBufferMinutes?: number;
}
export interface ViewingAttendee { email: string; name?: string; optional?: boolean }
export interface Viewing extends ViewingSlot {
  id: string;
  groupId: string;
  calendarId: string;
  availabilityCalendarIds: string[];
  actorId: string;
  conversationId: string;
  attendees: ViewingAttendee[];
  state: "proposed" | "booked" | "cancelled" | "uncertain";
  providerEventId: string;
  providerUrl?: string;
  providerEtag?: string;
  participantStatus: Array<{ email: string; response: string }>;
  participantConfirmation: "not_invited" | "awaiting_responses" | "accepted" | "declined";
  invitationsRequested: boolean;
  pending?: {
    requestId: string;
    action: "book" | "reschedule" | "cancel";
    startedAt: string;
    lockToken: string;
    desired?: ViewingSlot;
    previousState: "proposed" | "booked";
  };
  lastOperation?: { requestId: string; action: string; result: "completed" | "rejected" };
  operations?: Record<string, { fingerprint: string; action: string; result: "pending" | "completed" | "rejected" }>;
  lastCheckedAt?: string;
  issue?: string;
}
interface GoogleEvent {
  id: string;
  etag?: string;
  status?: string;
  htmlLink?: string;
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string; timeZone?: string };
  attendees?: Array<{ email?: string; responseStatus?: string }>;
  attendeesOmitted?: boolean;
  transparency?: string;
  extendedProperties?: { private?: Record<string, string> };
}
interface CalendarLock { token: string; workspaceId: string; viewingId: string; viewingVersion: number; held: boolean; createdAt: string }
export class CalendarWorkflowError extends Error {
  constructor(public code: string, message: string) { super(message); }
}
class GoogleError extends Error {
  constructor(public status: number, public reason: string) {
    super(`Google Calendar request failed (${status}: ${reason}).`);
  }
}
const VIEWING_KIND = "viewing";
const LOCK_KIND = "calendar_lock";
const LOCK_SCOPE = "system:google-calendar";
const minute = 60_000;
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const sameInstant = (a?: string, b?: string) => Boolean(a && b && Date.parse(a) === Date.parse(b));
const overlaps = (a: number, b: number, c: number, d: number) => a < d && c < b;
const slotFields = (v: ViewingSlot): ViewingSlot => ({ propertyId: v.propertyId, reference: v.reference, title: v.title, location: v.location, start: v.start, end: v.end, timeZone: v.timeZone, notes: v.notes, travelBufferMinutes: v.travelBufferMinutes ?? 0 });
const finishOperation = (viewing: Viewing, requestId: string, result: "completed" | "rejected") => {
  const key = hash(requestId); const entry = viewing.operations?.[key];
  return entry ? { ...viewing.operations, [key]: { ...entry, result } } : viewing.operations;
};

/** Explicit offsets disambiguate repeated DST hours; zone round-trip rejects gaps and wrong offsets. */
export function validateViewingSlot(slot: ViewingSlot): void {
  if (!Number.isSafeInteger(slot.propertyId) || slot.propertyId <= 0 || !slot.reference.trim()) {
    throw new CalendarWorkflowError("invalid_property", "A verified CRM property ID and reference are required.");
  }
  if (!slot.title.trim() || !slot.location.trim()) {
    throw new CalendarWorkflowError("missing_details", "Supply the viewing title and verified address or meeting location.");
  }
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-CA", { timeZone: slot.timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  } catch { throw new CalendarWorkflowError("invalid_timezone", "Supply an IANA timezone such as Europe/Lisbon."); }
  for (const value of [slot.start, slot.end]) {
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
    if (!match || !Number.isFinite(Date.parse(value))) throw new CalendarWorkflowError("invalid_time", "Start/end require RFC3339 timestamps with seconds and an explicit UTC offset.");
    const parts = Object.fromEntries(formatter.formatToParts(new Date(value)).map(part => [part.type, part.value]));
    const expected = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}`;
    if (`${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}` !== expected) {
      throw new CalendarWorkflowError("timezone_offset_mismatch", `The UTC offset in ${value} does not match ${slot.timeZone}, or the local time does not exist during a DST transition.`);
    }
  }
  const duration = Date.parse(slot.end) - Date.parse(slot.start);
  if (duration <= 0 || duration > 8 * 60 * minute) throw new CalendarWorkflowError("invalid_duration", "A viewing must end after it starts and last no more than eight hours.");
  const buffer = slot.travelBufferMinutes ?? 0;
  if (!Number.isInteger(buffer) || buffer < 0 || buffer > 180) throw new CalendarWorkflowError("invalid_buffer", "Travel buffers must be whole minutes between 0 and 180.");
}

/** Native REST client, with bounded requests and no implicit write retries. */
export class GoogleCalendarClient {
  private cachedToken?: { value: string; expires: number };
  constructor(private config: CalendarConfig, private fetcher: typeof fetch = fetch) {}
  private async token(): Promise<string> {
    if (this.cachedToken && this.cachedToken.expires > Date.now() + minute) return this.cachedToken.value;
    if (this.config.refreshToken && this.config.clientId && this.config.clientSecret) {
      const response = await this.fetcher("https://oauth2.googleapis.com/token", {
        method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "refresh_token", client_id: this.config.clientId, client_secret: this.config.clientSecret, refresh_token: this.config.refreshToken }),
        signal: AbortSignal.timeout(this.config.timeoutMs ?? 15_000),
      });
      if (!response.ok) throw new CalendarWorkflowError("calendar_oauth_failed", `Google OAuth refresh failed (${response.status}); reconnect the configured team account.`);
      const payload = await response.json() as { access_token?: string; expires_in?: number; scope?: string };
      if (!payload.access_token) throw new CalendarWorkflowError("calendar_oauth_failed", "Google OAuth did not return an access token.");
      // Google may omit scope on refresh. Actual endpoint authorization remains authoritative.
      if (payload.scope) {
        const scopes = payload.scope.split(" ");
        const broad = scopes.includes("https://www.googleapis.com/auth/calendar");
        const event = scopes.includes("https://www.googleapis.com/auth/calendar.events");
        const read = ["calendar.readonly", "calendar.events.freebusy", "calendar.freebusy"].some(s => scopes.includes(`https://www.googleapis.com/auth/${s}`));
        if (!broad && !(event && read)) throw new CalendarWorkflowError("calendar_scope_missing", "Authorize calendar.events and calendar.readonly (or calendar) for team event access, availability, and rescheduling.");
      }
      this.cachedToken = { value: payload.access_token, expires: Date.now() + (payload.expires_in ?? 3600) * 1000 };
      return payload.access_token;
    }
    if (this.config.accessToken) return this.config.accessToken;
    throw new CalendarWorkflowError("calendar_setup_missing", "Configure Google Calendar OAuth client ID, client secret and refresh token.");
  }
  async request<T>(path: string, method = "GET", body?: unknown, etag?: string): Promise<T> {
    const token = await this.token();
    const response = await this.fetcher(`https://www.googleapis.com/calendar/v3${path}`, {
      method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(etag ? { "If-Match": etag } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(this.config.timeoutMs ?? 15_000),
    });
    if (!response.ok) {
      let reason = "provider_error";
      try { reason = ((await response.json()) as { error?: { errors?: Array<{ reason?: string }> } }).error?.errors?.[0]?.reason ?? reason; } catch { /* Do not expose raw provider bodies/credentials. */ }
      throw new GoogleError(response.status, /^[a-zA-Z0-9_]+$/.test(reason) ? reason : "provider_error");
    }
    if (response.status === 204) return undefined as T;
    return await response.json() as T;
  }
  eventPath(calendar: string, id: string) { return `/calendars/${encodeURIComponent(calendar)}/events/${encodeURIComponent(id)}`; }
  async getEvent(calendar: string, id: string): Promise<GoogleEvent | null> {
    try { return await this.request<GoogleEvent>(this.eventPath(calendar, id)); }
    catch (error) { if (error instanceof GoogleError && [404, 410].includes(error.status)) return null; throw error; }
  }
}

export class CalendarWorkflowService {
  private provider: GoogleCalendarClient;
  constructor(private store: CalendarStore, private config: CalendarConfig = calendarConfigFromEnv(), fetcher: typeof fetch = fetch) {
    this.provider = new GoogleCalendarClient(config, fetcher);
  }
  private workspaces() { return [...new Set([this.config.workspaceId, ...(this.config.workspaceIds ?? [])].map(id => id?.trim()).filter((id): id is string => Boolean(id)))]; }
  setup(scope: CalendarScope) {
    const missing: string[] = [];
    const workspaces = this.workspaces();
    if (!workspaces.length) missing.push("GOOGLE_CALENDAR_WORKSPACE_IDS (or GOOGLE_CALENDAR_WORKSPACE_ID)");
    if (workspaces.length > 100) missing.push("GOOGLE_CALENDAR_WORKSPACE_IDS must contain at most 100 unique workspaces");
    if (!this.config.authorizedActorIds.length) missing.push("GOOGLE_CALENDAR_AUTHORIZED_ACTOR_IDS");
    if (!this.config.allowedCalendarIds.length) missing.push("GOOGLE_CALENDAR_ALLOWED_IDS");
    if (this.config.allowedCalendarIds.includes("primary")) missing.push("GOOGLE_CALENDAR_ALLOWED_IDS must use canonical calendar IDs, not the primary alias, so shared calendar locks cannot be bypassed");
    if (!this.config.accessToken && !(this.config.clientId && this.config.clientSecret && this.config.refreshToken)) missing.push("GOOGLE_CALENDAR_CLIENT_ID, GOOGLE_CALENDAR_CLIENT_SECRET, GOOGLE_CALENDAR_REFRESH_TOKEN");
    const authorized = workspaces.includes(scope.workspaceId) && this.config.authorizedActorIds.includes(scope.actorId);
    return {
      configured: missing.length === 0, authorized, missing,
      workspaceId: scope.workspaceId, actorId: scope.actorId,
      calendarIds: authorized ? this.config.allowedCalendarIds : [],
      requiredScopes: ["https://www.googleapis.com/auth/calendar.events", "https://www.googleapis.com/auth/calendar.readonly"],
      message: "The deployed application needs the team's OAuth account and explicit workspace/actor/calendar allowlists. A developer's Calendar connector does not configure this integration.",
    };
  }
  private authorize(scope: CalendarScope, calendars?: string[], providerRequired = true) {
    const setup = this.setup(scope);
    // Drafts may be stored before the provider is configured, without calendar data access.
    if (!providerRequired) return;
    if (!setup.configured) throw new CalendarWorkflowError("calendar_setup_missing", `Google Calendar setup is missing: ${setup.missing.join("; ")}.`);
    if (!setup.authorized) throw new CalendarWorkflowError("calendar_forbidden", "This actor/workspace is not authorized for the configured team calendars.");
    if (calendars?.some(id => !this.config.allowedCalendarIds.includes(id))) throw new CalendarWorkflowError("calendar_forbidden", "Every requested calendar must be in GOOGLE_CALENDAR_ALLOWED_IDS; availability cannot be checked for inaccessible calendars.");
  }
  private async read(scope: CalendarScope, id: string) {
    const record = await this.store.get<Viewing>(scope.workspaceId, VIEWING_KIND, id);
    if (!record) throw new CalendarWorkflowError("viewing_not_found", "No viewing with that ID exists in this workspace.");
    return record;
  }
  async get(scope: CalendarScope, id: string) { return (await this.read(scope, id)).data; }
  async list(scope: CalendarScope, limit = 100) {
    return (await this.store.list<Viewing>(scope.workspaceId, VIEWING_KIND, Math.min(limit, 100))).map(record => record.data);
  }
  async propose(scope: CalendarScope, input: {
    requestId: string; calendarId: string; availabilityCalendarIds?: string[]; attendees?: ViewingAttendee[]; viewings: ViewingSlot[];
  }) {
    if (!input.requestId.trim() || input.requestId.length > 200) throw new CalendarWorkflowError("invalid_request_id", "Use a stable request ID of 1–200 characters.");
    if (!input.calendarId.trim() || input.calendarId.length > 300) throw new CalendarWorkflowError("missing_calendar", "Supply the intended team calendar ID.");
    if ((input.availabilityCalendarIds?.length ?? 0) > 49) throw new CalendarWorkflowError("too_many_calendars", "At most 50 calendars may be checked per viewing.");
    if (!input.viewings.length || input.viewings.length > 10) throw new CalendarWorkflowError("invalid_viewings", "Propose between one and ten viewings.");
    const attendees = (input.attendees ?? []).map(a => ({ ...a, email: a.email.trim().toLowerCase() }));
    if (attendees.length > 50 || attendees.some(a => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a.email)) || new Set(attendees.map(a => a.email)).size !== attendees.length) throw new CalendarWorkflowError("invalid_attendees", "Supply at most 50 unique, valid participant email addresses.");
    input.viewings.forEach(validateViewingSlot);
    const sorted = [...input.viewings].sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
    for (let i = 1; i < sorted.length; i++) {
      const previous = sorted[i - 1]!; const next = sorted[i]!;
      if (Date.parse(next.start) < Date.parse(previous.end) + (previous.travelBufferMinutes ?? 0) * minute) throw new CalendarWorkflowError("travel_conflict", "Consecutive viewings overlap or leave insufficient travel time after the preceding viewing.");
    }
    const groupId = hash(`${scope.workspaceId}:${input.requestId}`).slice(0, 32);
    const availabilityCalendarIds = [...new Set([input.calendarId, ...(input.availabilityCalendarIds ?? [])])];
    const groupFingerprint = hash(JSON.stringify({ calendarId: input.calendarId, availabilityCalendarIds, attendees, viewings: input.viewings.map(slotFields) }));
    if (!await this.store.create(scope.workspaceId, "viewing_group", groupId, { fingerprint: groupFingerprint })) {
      const existing = await this.store.get<{ fingerprint: string }>(scope.workspaceId, "viewing_group", groupId);
      if (existing?.data.fingerprint !== groupFingerprint) throw new CalendarWorkflowError("request_id_reused", "This request ID already refers to different viewing details. Use a new request ID for a new proposal.");
    }
    const result: Viewing[] = [];
    for (let index = 0; index < input.viewings.length; index++) {
      const slot = slotFields(input.viewings[index]!);
      const id = hash(`${groupId}:${index}`).slice(0, 32);
      const draft: Viewing = { ...slot, id, groupId, calendarId: input.calendarId,
        availabilityCalendarIds, actorId: scope.actorId, conversationId: scope.conversationId,
        attendees, state: "proposed", providerEventId: hash(`bonte:${scope.workspaceId}:${id}`), participantStatus: [], participantConfirmation: "not_invited", invitationsRequested: false };
      if (!await this.store.create(scope.workspaceId, VIEWING_KIND, id, draft)) {
        const existing = (await this.read(scope, id)).data;
        result.push(existing);
      } else result.push(draft);
    }
    return { groupId, viewings: result, calendarSetup: this.setup(scope), message: "Proposals are saved in Bonte. No calendar event or invitation has been created." };
  }
  async availability(scope: CalendarScope, id: string, replacement?: ViewingSlot) {
    const record = await this.read(scope, id); const viewing = record.data;
    this.authorize(scope, viewing.availabilityCalendarIds);
    const slot = replacement ?? viewing; validateViewingSlot(slot);
    const start = Date.parse(slot.start);
    const end = Date.parse(slot.end) + (slot.travelBufferMinutes ?? 0) * minute;
    const conflicts: Array<{ calendarId: string; start: string; end: string }> = [];
    const unknownCalendars: string[] = [];
    // ponytail: bounded scans (100 workspaces × 10k records); add a time-range index if team volume warrants it.
    for (const workspaceId of this.workspaces()) {
      const saved = await this.store.list<Viewing>(workspaceId, VIEWING_KIND, 10_000);
      if (saved.length === 10_000) unknownCalendars.push("local viewing history exceeds lookup limit");
      for (const record of saved) {
        const other = record.data;
        if ((workspaceId === scope.workspaceId && other.id === viewing.id) || !viewing.availabilityCalendarIds.includes(other.calendarId) || !["booked", "uncertain"].includes(other.state)) continue;
        const otherEnd = Date.parse(other.end) + (other.travelBufferMinutes ?? 0) * minute;
        if (overlaps(start, end, Date.parse(other.start), otherEnd)) conflicts.push({ calendarId: other.calendarId, start: other.start, end: new Date(otherEnd).toISOString() });
      }
    }
    const otherCalendars = viewing.availabilityCalendarIds.filter(calendar => !(viewing.state === "booked" && calendar === viewing.calendarId));
    if (otherCalendars.length) {
      const result = await this.provider.request<{ calendars?: Record<string, { busy?: Array<{ start: string; end: string }>; errors?: unknown[] }> }>("/freeBusy", "POST", { timeMin: new Date(start).toISOString(), timeMax: new Date(end).toISOString(), timeZone: slot.timeZone, items: otherCalendars.map(calendarId => ({ id: calendarId })) });
      for (const calendar of otherCalendars) {
        const item = result.calendars?.[calendar];
        if (!item || item.errors?.length || !Array.isArray(item.busy)) { unknownCalendars.push(calendar); continue; }
        for (const busy of item.busy) {
          if (!Number.isFinite(Date.parse(busy.start)) || !Number.isFinite(Date.parse(busy.end))) { unknownCalendars.push(calendar); continue; }
          if (overlaps(start, end, Date.parse(busy.start), Date.parse(busy.end))) conflicts.push({ calendarId: calendar, ...busy });
        }
      }
    }
    // freeBusy has no event identities. On reschedule use paginated events to exclude ONLY this viewing.
    if (viewing.state === "booked") {
      let pageToken: string | undefined; let pages = 0;
      do {
        const query = new URLSearchParams({ timeMin: new Date(start).toISOString(), timeMax: new Date(end).toISOString(), singleEvents: "true", maxResults: "2500", ...(pageToken ? { pageToken } : {}) });
        const data: { items?: GoogleEvent[]; nextPageToken?: string } = await this.provider.request(`/calendars/${encodeURIComponent(viewing.calendarId)}/events?${query}`);
        for (const event of data.items ?? []) {
          if (event.id === viewing.providerEventId || event.status === "cancelled" || event.transparency === "transparent") continue;
          if (event.start?.date || event.end?.date) { conflicts.push({ calendarId: viewing.calendarId, start: event.start?.date ?? slot.start, end: event.end?.date ?? slot.end }); continue; }
          if (!event.start?.dateTime || !event.end?.dateTime || !Number.isFinite(Date.parse(event.start.dateTime)) || !Number.isFinite(Date.parse(event.end.dateTime))) { unknownCalendars.push(viewing.calendarId); continue; }
          if (overlaps(start, end, Date.parse(event.start.dateTime), Date.parse(event.end.dateTime))) conflicts.push({ calendarId: viewing.calendarId, start: event.start.dateTime, end: event.end.dateTime });
        }
        pageToken = data.nextPageToken; pages++;
      } while (pageToken && pages < 20);
      if (pageToken) unknownCalendars.push(viewing.calendarId);
    }
    return { available: conflicts.length === 0 && unknownCalendars.length === 0, conflicts, unknownCalendars: [...new Set(unknownCalendars)], checkedCalendarIds: viewing.availabilityCalendarIds, checkedAt: new Date().toISOString(), coverage: "Checks only configured accessible calendars. External participants may have unknown availability. Calendar availability checks and writes are separate provider operations." };
  }
  private eventBody(scope: CalendarScope, viewing: Viewing, slot: ViewingSlot, operationId: string, invite: boolean, insert: boolean) {
    return {
      ...(insert ? { id: viewing.providerEventId, attendees: invite ? viewing.attendees.map(a => ({ email: a.email, displayName: a.name, optional: a.optional, responseStatus: "needsAction" })) : [], guestsCanModify: false,
        summary: `Viewing ${slot.reference} · ${slot.title}`, location: slot.location,
        description: [slot.notes, `CRM property ${slot.propertyId} (${slot.reference}).`].filter(Boolean).join("\n") } : {}),
      start: { dateTime: slot.start, timeZone: slot.timeZone }, end: { dateTime: slot.end, timeZone: slot.timeZone },
      extendedProperties: { private: { bonteWorkspace: hash(scope.workspaceId), bonteViewing: viewing.id, bonteOperation: hash(operationId) } },
    };
  }
  private owned(scope: CalendarScope, viewing: Viewing, event: GoogleEvent) {
    return event.id === viewing.providerEventId && event.extendedProperties?.private?.bonteWorkspace === hash(scope.workspaceId) && event.extendedProperties?.private?.bonteViewing === viewing.id;
  }
  private withProvider(viewing: Viewing, event: GoogleEvent): Viewing {
    const participants = viewing.attendees.map(attendee => ({ email: attendee.email, response: event.attendees?.find(a => a.email?.toLowerCase() === attendee.email)?.responseStatus ?? "needsAction" }));
    const confirmation = !viewing.invitationsRequested || !participants.length ? "not_invited" : participants.some(a => a.response === "declined") ? "declined" : !event.attendeesOmitted && participants.every(a => a.response === "accepted") ? "accepted" : "awaiting_responses";
    return { ...viewing, providerUrl: event.htmlLink, providerEtag: event.etag, participantStatus: participants, participantConfirmation: confirmation, lastCheckedAt: new Date().toISOString() };
  }
  private async acquire(scope: CalendarScope, viewing: Viewing, version: number): Promise<string> {
    const id = hash(viewing.calendarId); const token = randomUUID();
    const data = { token, workspaceId: scope.workspaceId, viewingId: viewing.id, viewingVersion: version, held: true, createdAt: new Date().toISOString() };
    if (await this.store.create(LOCK_SCOPE, LOCK_KIND, id, data)) return token;
    const current = await this.store.get<CalendarLock>(LOCK_SCOPE, LOCK_KIND, id);
    if (current && !current.data.held && await this.store.compareAndSet(LOCK_SCOPE, LOCK_KIND, id, current.version, data)) return token;
    const recovery = current?.data.workspaceId === scope.workspaceId ? `Reconcile viewing ${current.data.viewingId} before retrying.` : "The team member who started it must reconcile it before another booking.";
    throw new CalendarWorkflowError("calendar_busy", `Another calendar operation is pending. ${recovery} A stale lock is never silently stolen after a provider timeout.`);
  }
  private async release(scope: CalendarScope, viewing: Viewing, token: string) {
    const id = hash(viewing.calendarId); const lock = await this.store.get<CalendarLock>(LOCK_SCOPE, LOCK_KIND, id);
    if (lock?.data.held && lock.data.workspaceId === scope.workspaceId && lock.data.viewingId === viewing.id && token === lock.data.token) {
      await this.store.compareAndSet(LOCK_SCOPE, LOCK_KIND, id, lock.version, { ...lock.data, held: false });
    }
  }
  async reconcile(scope: CalendarScope, id: string): Promise<Viewing> {
    let record = await this.read(scope, id); let viewing = record.data;
    if (!viewing.pending) {
      const lock = await this.store.get<CalendarLock>(LOCK_SCOPE, LOCK_KIND, hash(viewing.calendarId));
      if (lock?.data.held && lock.data.workspaceId === scope.workspaceId && lock.data.viewingId === id && Date.now() - Date.parse(lock.data.createdAt) > 60_000) {
        this.authorize(scope, [viewing.calendarId]);
        // Fence a worker paused before its durable write claim. It must use the original
        // viewing version captured in acquire(), so this CAS prevents a late provider write.
        if (await this.store.compareAndSet(scope.workspaceId, VIEWING_KIND, id, record.version, viewing)) {
          await this.release(scope, viewing, lock.data.token);
          record = await this.read(scope, id); viewing = record.data;
        } else return (await this.read(scope, id)).data;
      }
    }
    if (viewing.state === "proposed" || viewing.state === "cancelled") return viewing;
    this.authorize(scope, [viewing.calendarId]);
    let event: GoogleEvent | null;
    try { event = await this.provider.getEvent(viewing.calendarId, viewing.providerEventId); }
    catch { return { ...viewing, issue: "Calendar readback failed. The stored state is retained; do not retry a write until reconciliation succeeds." }; }
    let next = viewing;
    if (!event || event.status === "cancelled") {
      if (viewing.pending?.action === "cancel" || viewing.state === "booked") {
        next = { ...viewing, state: "cancelled", pending: undefined, issue: undefined, lastCheckedAt: new Date().toISOString(), ...(viewing.pending ? { operations: finishOperation(viewing, viewing.pending.requestId, "completed"), lastOperation: { requestId: viewing.pending.requestId, action: "cancel", result: "completed" as const } } : {}) };
      } else return { ...viewing, issue: "The event is not visible in Google Calendar. This does not prove a timed-out write failed. The request remains uncertain; do not create a replacement event." };
    } else if (!this.owned(scope, viewing, event)) {
      return { ...viewing, issue: "The provider event ID belongs to another event. No update, deletion, or replacement was attempted. Administrator reconciliation is required." };
    } else if (viewing.pending) {
      const desired = viewing.pending.desired ?? viewing;
      if (viewing.pending.action === "cancel" || event.extendedProperties?.private?.bonteOperation !== hash(viewing.pending.requestId) || !sameInstant(event.start?.dateTime, desired.start) || !sameInstant(event.end?.dateTime, desired.end)) {
        return { ...this.withProvider(viewing, event), issue: "Readback does not yet confirm the requested operation. Keep this request uncertain; do not repeat the write." };
      }
      next = { ...this.withProvider({ ...viewing, ...slotFields(desired) }, event), state: "booked", pending: undefined, issue: undefined, operations: finishOperation(viewing, viewing.pending.requestId, "completed"), lastOperation: { requestId: viewing.pending.requestId, action: viewing.pending.action, result: "completed" } };
    } else next = { ...this.withProvider(viewing, event), issue: !sameInstant(event.start?.dateTime, viewing.start) || !sameInstant(event.end?.dateTime, viewing.end) ? "The event was moved outside Bonte. Refresh/review the provider time before scheduling further changes." : undefined };
    if (await this.store.compareAndSet(scope.workspaceId, VIEWING_KIND, id, record.version, next)) {
      if (viewing.pending && !next.pending) await this.release(scope, viewing, viewing.pending.lockToken);
      return next;
    }
    return (await this.read(scope, id)).data;
  }
  async mutate(scope: CalendarScope, input: { id: string; requestId: string; action: "book" | "reschedule" | "cancel"; explicitlyRequested: boolean; sendInvitations?: boolean; replacement?: ViewingSlot }): Promise<Viewing> {
    if (!input.explicitlyRequested) throw new CalendarWorkflowError("explicit_request_required", "Book, change or cancel only when the user has explicitly requested that action. A proposal is not a booking request.");
    if (!input.requestId.trim() || input.requestId.length > 200) throw new CalendarWorkflowError("invalid_request_id", "Use a stable request ID of 1–200 characters.");
    let record = await this.read(scope, input.id); let viewing = record.data;
    const desired = slotFields(input.replacement ?? viewing);
    const operationKey = hash(input.requestId);
    const fingerprint = hash(JSON.stringify({ action: input.action, desired: input.action === "reschedule" ? desired : undefined, invite: input.action === "book" ? Boolean(input.sendInvitations) : undefined }));
    const previousOperation = viewing.operations?.[operationKey];
    if (previousOperation) {
      if (previousOperation.fingerprint !== fingerprint) throw new CalendarWorkflowError("request_id_reused", "This request ID already refers to different action details.");
      return viewing.pending ? await this.reconcile(scope, input.id) : viewing;
    }
    if (input.action === "cancel" && viewing.state === "proposed") {
      const next: Viewing = { ...viewing, state: "cancelled", operations: { ...viewing.operations, [operationKey]: { fingerprint, action: input.action, result: "completed" } }, lastOperation: { requestId: input.requestId, action: input.action, result: "completed" } };
      if (!await this.store.compareAndSet(scope.workspaceId, VIEWING_KIND, input.id, record.version, next)) throw new CalendarWorkflowError("viewing_changed", "The viewing changed concurrently; inspect it before retrying.");
      return next;
    }
    this.authorize(scope, viewing.availabilityCalendarIds);
    if (viewing.pending) {
      const pendingRequestId = viewing.pending.requestId;
      const reconciled = await this.reconcile(scope, input.id);
      if (pendingRequestId !== input.requestId && !reconciled.pending) {
        throw new CalendarWorkflowError("previous_operation_reconciled", "The previous operation was reconciled. Inspect its result and retry the current requested action; this call did not perform that new action.");
      }
      return reconciled;
    }
    if (viewing.lastOperation?.requestId === input.requestId) {
      if (viewing.lastOperation.action !== input.action) throw new CalendarWorkflowError("request_id_reused", "This action request ID has already been used for another operation.");
      return viewing;
    }
    if (viewing.state === "cancelled") {
      if (input.action !== "cancel") throw new CalendarWorkflowError("viewing_cancelled", "This viewing is cancelled. Create a new proposal to book another viewing.");
      return viewing;
    }
    if (input.action === "book" && viewing.state === "booked") return this.reconcile(scope, input.id);
    if (input.action !== "book" && viewing.state !== "booked") {
      throw new CalendarWorkflowError("invalid_state", "Rescheduling requires a booked viewing.");
    }
    if (input.action === "reschedule" && !input.replacement) throw new CalendarWorkflowError("missing_time", "Supply the new viewing date, time and timezone.");
    validateViewingSlot(desired);
    if (desired.propertyId !== viewing.propertyId || desired.reference !== viewing.reference) throw new CalendarWorkflowError("property_changed", "Rescheduling cannot change the property. Propose a separate viewing for another property.");
    const lock = await this.acquire(scope, viewing, record.version);
    let claimed = false;
    try {
      // Keep this exact record version: stale pre-write recovery fences it using CAS.
      if (input.action !== "cancel") {
        const availability = await this.availability(scope, input.id, desired);
        if (!availability.available) throw new CalendarWorkflowError("calendar_conflict", `Viewing cannot be booked at this time: ${availability.conflicts.length} conflict(s); calendars with unavailable evidence: ${availability.unknownCalendars.join(", ") || "none"}.`);
      }
      let currentEvent: GoogleEvent | null = null;
      if (input.action !== "book") {
        currentEvent = await this.provider.getEvent(viewing.calendarId, viewing.providerEventId);
        if (!currentEvent || currentEvent.status === "cancelled") throw new CalendarWorkflowError("provider_event_missing", "The calendar event is missing or cancelled. Reconcile the viewing before continuing.");
        if (!this.owned(scope, viewing, currentEvent) || !currentEvent.etag) throw new CalendarWorkflowError("provider_event_mismatch", "Cannot verify the event identity and version; no change was attempted.");
      }
      const invitationsRequested = input.action === "book" ? Boolean(input.sendInvitations) : viewing.invitationsRequested;
      const pending: Viewing = { ...viewing, invitationsRequested, state: "uncertain", issue: undefined, operations: { ...viewing.operations, [operationKey]: { fingerprint, action: input.action, result: "pending" } },
        pending: { requestId: input.requestId, action: input.action, startedAt: new Date().toISOString(), lockToken: lock, desired: input.action === "cancel" ? undefined : desired, previousState: viewing.state as "proposed" | "booked" } };
      if (!await this.store.compareAndSet(scope.workspaceId, VIEWING_KIND, input.id, record.version, pending)) throw new CalendarWorkflowError("viewing_changed", "The viewing changed concurrently; inspect it before retrying.");
      claimed = true;
      const sendUpdates = invitationsRequested ? "all" : "none";
      try {
        if (input.action === "book") {
          await this.provider.request(`/calendars/${encodeURIComponent(viewing.calendarId)}/events?sendUpdates=${sendUpdates}`, "POST", this.eventBody(scope, pending, desired, input.requestId, invitationsRequested, true));
        } else if (input.action === "reschedule") {
          const update = this.eventBody(scope, pending, desired, input.requestId, invitationsRequested, false);
          update.extendedProperties.private = { ...currentEvent?.extendedProperties?.private, ...update.extendedProperties.private };
          await this.provider.request(`${this.provider.eventPath(viewing.calendarId, viewing.providerEventId)}?sendUpdates=${sendUpdates}`, "PATCH", update, currentEvent!.etag);
        } else await this.provider.request(`${this.provider.eventPath(viewing.calendarId, viewing.providerEventId)}?sendUpdates=${sendUpdates}`, "DELETE", undefined, currentEvent!.etag);
      } catch (error) {
        // A deterministic 4xx rejection proves this request was not applied. 409 needs identity readback.
        if ((error instanceof GoogleError && [400, 401, 403, 404, 412, 422].includes(error.status)) || error instanceof CalendarWorkflowError) {
          const latest = await this.read(scope, input.id);
          const next: Viewing = { ...viewing, issue: error.message, operations: finishOperation(pending, input.requestId, "rejected"), lastOperation: { requestId: input.requestId, action: input.action, result: "rejected" } };
          if (latest.data.pending?.requestId === input.requestId && await this.store.compareAndSet(scope.workspaceId, VIEWING_KIND, input.id, latest.version, next)) {
            await this.release(scope, viewing, lock); return next;
          }
        }
        // A timeout, 409, rate limit or provider error can have an unknown outcome. Read; never repeat the write.
      }
      return await this.reconcile(scope, input.id);
    } finally {
      if (!claimed) await this.release(scope, viewing, lock);
      else {
        const latest = await this.read(scope, input.id);
        if (!latest.data.pending) await this.release(scope, viewing, lock);
      }
    }
  }
}
