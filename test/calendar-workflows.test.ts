import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CalendarWorkflowService, GoogleCalendarClient, calendarConfigFromEnv, validateViewingSlot, type CalendarConfig, type ViewingSlot } from "../src/workflows/calendar.js";
import { MemoryWorkflowStore } from "../src/workflows/store.js";

const scope = { workspaceId: "test-workspace", actorId: "broker-1", conversationId: "chat-1" };
const config: CalendarConfig = { workspaceId: scope.workspaceId, authorizedActorIds: [scope.actorId], allowedCalendarIds: ["team@example.test", "broker@example.test"], accessToken: "synthetic-token", timeoutMs: 50 };
const slot: ViewingSlot = { propertyId: 12, reference: "BON-12", title: "Cascais villa", location: "Verified meeting point", start: "2026-09-20T10:00:00+01:00", end: "2026-09-20T10:30:00+01:00", timeZone: "Europe/Lisbon", travelBufferMinutes: 15 };
const attendees = [{ email: "buyer@example.test" }, { email: "owner@example.test" }];
type Event = Record<string, any>;

class FakeGoogle {
  events = new Map<string, Event>();
  calls: Array<{ method: string; url: URL; body?: any; headers: Headers }> = [];
  busy: Array<{ start: string; end: string }> = [];
  freebusyErrors = false;
  externalEvents: Event[] = [];
  failWrite?: "before" | "after" | "rejected" | "precondition";
  failGet = false;
  collide = false;
  blockInsert?: Promise<void>;
  blockAvailability?: Promise<void>;
  oauthScope = "https://www.googleapis.com/auth/calendar";
  fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input)); const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    this.calls.push({ method, url, body, headers: new Headers(init?.headers) });
    const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
    const error = (status: number, reason: string) => json({ error: { errors: [{ reason }] } }, status);
    if (url.hostname === "oauth2.googleapis.com") return json({ access_token: "synthetic-refreshed", expires_in: 3600, scope: this.oauthScope });
    if (url.pathname.endsWith("/freeBusy")) {
      if (this.blockAvailability) await this.blockAvailability;
      return json({ calendars: Object.fromEntries(body.items.map(({ id }: { id: string }) => [id, this.freebusyErrors ? { errors: [{ reason: "notFound" }] } : { busy: this.busy }])) });
    }
    if (method === "GET" && url.pathname.endsWith("/events")) return json({ items: [...this.events.values(), ...this.externalEvents] });
    const eventId = decodeURIComponent(url.pathname.split("/").at(-1)!);
    if (method === "GET") {
      if (this.failGet) throw new Error("synthetic read outage");
      return this.events.has(eventId) ? json(this.events.get(eventId)) : error(404, "notFound");
    }
    if (this.failWrite === "before") throw new Error("synthetic network timeout before response");
    if (this.failWrite === "rejected") return error(403, "forbidden");
    if (this.failWrite === "precondition") return error(412, "conditionNotMet");
    let event: Event | undefined;
    if (method === "POST") {
      if (this.blockInsert) await this.blockInsert;
      if (this.collide) { this.events.set(body.id, { id: body.id, start: body.start, end: body.end, extendedProperties: { private: { bonteViewing: "someone-else" } } }); return error(409, "duplicate"); }
      if (this.events.has(body.id)) return error(409, "duplicate");
      event = { ...body, status: "confirmed", etag: '"1"', htmlLink: `https://calendar.google.com/calendar/event?eid=${body.id}` };
      this.events.set(body.id, event);
    } else if (method === "PATCH") {
      event = { ...this.events.get(eventId), ...body, etag: '"2"' }; this.events.set(eventId, event);
    } else if (method === "DELETE") this.events.delete(eventId);
    if (this.failWrite === "after") throw new Error("synthetic timeout after Google accepted write");
    return method === "DELETE" ? new Response(null, { status: 204 }) : json(event);
  };
  writes(method?: string) { return this.calls.filter(c => c.url.pathname.includes("/events") && c.method !== "GET" && (!method || c.method === method)); }
}
function fixture(override: Partial<CalendarConfig> = {}) {
  const store = new MemoryWorkflowStore(); const google = new FakeGoogle();
  const workflow = new CalendarWorkflowService(store, { ...config, ...override }, google.fetch);
  return { store, google, workflow };
}
async function proposed(workflow: CalendarWorkflowService, viewings = [slot], requestId = "proposal-one") {
  return (await workflow.propose(scope, { requestId, calendarId: config.allowedCalendarIds[0]!, attendees, viewings })).viewings;
}
async function book(workflow: CalendarWorkflowService, id: string, requestId = "booking-one") {
  return workflow.mutate(scope, { id, requestId, action: "book", explicitlyRequested: true, sendInvitations: true });
}

describe("Google Calendar viewing workflows", () => {
  it("keeps proposals durable without claiming a booking or needing provider configuration", async () => {
    const { workflow, store, google } = fixture({ accessToken: undefined });
    const [viewing] = await proposed(workflow);
    assert.equal(viewing.state, "proposed");
    assert.equal(google.calls.length, 0);
    assert.equal((await new CalendarWorkflowService(store, { ...config, accessToken: undefined }, google.fetch).get(scope, viewing.id)).id, viewing.id);
    await assert.rejects(book(workflow, viewing.id), /setup is missing/);
    const cancelled = await workflow.mutate(scope, { id: viewing.id, requestId: "cancel-local", action: "cancel", explicitlyRequested: true });
    assert.equal(cancelled.state, "cancelled"); assert.equal(google.calls.length, 0);
  });
  it("rejects a different workspace, actor, or calendar before provider access", async () => {
    const { workflow, google } = fixture(); const [viewing] = await proposed(workflow);
    await assert.rejects(workflow.get({ ...scope, workspaceId: "another-workspace" }, viewing.id), /No viewing/);
    await assert.rejects(workflow.availability({ ...scope, actorId: "outsider" }, viewing.id), /not authorized/);
    const [foreign] = (await workflow.propose(scope, { requestId: "foreign", calendarId: "private@example.test", viewings: [slot] })).viewings;
    await assert.rejects(book(workflow, foreign.id), /ALLOW|allow|Every requested/);
    assert.equal(google.calls.length, 0);
  });
  it("supports plural workspace allowlists and the legacy singular setting without exposing another user's viewings", async () => {
    const otherScope = { ...scope, workspaceId: "other-authorized-workspace", actorId: "broker-2" };
    const fromEnv = calendarConfigFromEnv({ GOOGLE_CALENDAR_WORKSPACE_ID: scope.workspaceId, GOOGLE_CALENDAR_WORKSPACE_IDS: ` ${otherScope.workspaceId}, ${scope.workspaceId} `, GOOGLE_CALENDAR_AUTHORIZED_ACTOR_IDS: `${scope.actorId},${otherScope.actorId}`, GOOGLE_CALENDAR_ALLOWED_IDS: "team@example.test", GOOGLE_CALENDAR_ACCESS_TOKEN: "synthetic-token" });
    const store = new MemoryWorkflowStore(); const google = new FakeGoogle(); const workflow = new CalendarWorkflowService(store, fromEnv, google.fetch);
    assert.equal(workflow.setup(scope).authorized, true); assert.equal(workflow.setup(otherScope).authorized, true);
    assert.equal(workflow.setup({ ...otherScope, actorId: "outsider" }).authorized, false);
    const [first] = await proposed(workflow);
    await assert.rejects(workflow.get(otherScope, first.id), /No viewing/);
    assert.deepEqual(await workflow.list(otherScope), []);
    const other = (await workflow.propose(otherScope, { requestId: "other-proposal", calendarId: "team@example.test", viewings: [{ ...slot, start: "2026-09-20T11:00:00+01:00", end: "2026-09-20T11:30:00+01:00" }] })).viewings[0]!;
    assert.equal((await workflow.mutate(otherScope, { id: other.id, requestId: "other-book", action: "book", explicitlyRequested: true })).state, "booked");
    assert.deepEqual((await workflow.list(scope)).map(v => v.id), [first.id]);
    assert.equal(new CalendarWorkflowService(store, { ...fromEnv, workspaceId: undefined, workspaceIds: [otherScope.workspaceId] }, google.fetch).setup(otherScope).authorized, true);
    assert.equal(new CalendarWorkflowService(store, { ...fromEnv, workspaceIds: Array.from({ length: 101 }, (_, index) => `workspace-${index}`) }, google.fetch).setup(scope).configured, false);
    assert.equal(new CalendarWorkflowService(store, { ...fromEnv, allowedCalendarIds: ["primary"] }, google.fetch).setup(scope).configured, false);
  });
  it("serializes writes across team workspaces and applies shared travel buffers without revealing viewing details", async () => {
    const otherScope = { ...scope, workspaceId: "other-authorized-workspace", actorId: "broker-2" };
    const { workflow, google } = fixture({ workspaceIds: [otherScope.workspaceId], authorizedActorIds: [scope.actorId, otherScope.actorId] });
    const [first] = await proposed(workflow);
    const other = (await workflow.propose(otherScope, { requestId: "other-proposal", calendarId: "team@example.test", viewings: [{ ...slot, start: "2026-09-20T10:35:00+01:00", end: "2026-09-20T11:00:00+01:00" }] })).viewings[0]!;
    let release!: () => void; google.blockInsert = new Promise<void>(resolve => { release = resolve; });
    const firstBooking = book(workflow, first.id);
    while (!google.writes().length) await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(workflow.mutate(otherScope, { id: other.id, requestId: "other-book", action: "book", explicitlyRequested: true }), error => error instanceof Error && /team member/.test(error.message) && !error.message.includes(first.id));
    release(); assert.equal((await firstBooking).state, "booked");
    const availability = await workflow.availability(otherScope, other.id);
    assert.equal(availability.available, false); assert.ok(availability.conflicts.length > 0);
    assert.ok(availability.conflicts.every(conflict => Object.keys(conflict).sort().join(",") === "calendarId,end,start"));
    assert.equal(google.writes().length, 1);
    await assert.rejects(workflow.mutate(otherScope, { id: other.id, requestId: "other-book", action: "book", explicitlyRequested: true }), /conflict/);
  });
  it("requires explicit booking authorization and validates unique participant addresses", async () => {
    const { workflow, google } = fixture(); const [viewing] = await proposed(workflow);
    await assert.rejects(workflow.mutate(scope, { id: viewing.id, requestId: "book", action: "book", explicitlyRequested: false }), /explicitly requested/);
    await assert.rejects(workflow.propose(scope, { requestId: "bad", calendarId: "team@example.test", attendees: [{ email: "owner@" }], viewings: [slot] }), /valid participant/);
    assert.equal(google.calls.length, 0);
  });
  it("requires explicit timezone offsets and rejects nonexistent DST times and mismatched offsets", () => {
    assert.doesNotThrow(() => validateViewingSlot(slot));
    assert.throws(() => validateViewingSlot({ ...slot, start: "2026-09-20T10:00:00" }), /explicit UTC offset/);
    assert.throws(() => validateViewingSlot({ ...slot, start: "2026-09-20T10:00:00Z" }), /does not match/);
    assert.throws(() => validateViewingSlot({ ...slot, start: "2026-03-29T01:15:00+00:00", end: "2026-03-29T03:15:00+01:00" }), /does not match/);
    assert.doesNotThrow(() => validateViewingSlot({ ...slot, start: "2026-10-25T01:15:00+01:00", end: "2026-10-25T01:45:00+01:00" }));
    assert.doesNotThrow(() => validateViewingSlot({ ...slot, start: "2026-10-25T01:15:00+00:00", end: "2026-10-25T01:45:00+00:00" }));
  });
  it("books two consecutive properties with travel time and separates invitations from acceptance", async () => {
    const { workflow, google } = fixture();
    const second = { ...slot, propertyId: 13, reference: "BON-13", start: "2026-09-20T10:45:00+01:00", end: "2026-09-20T11:15:00+01:00" };
    await assert.rejects(proposed(workflow, [slot, { ...second, start: "2026-09-20T10:35:00+01:00" }]), /insufficient travel time/);
    const viewings = await proposed(workflow, [slot, second]);
    const results = [];
    for (const viewing of viewings) results.push(await book(workflow, viewing.id));
    assert.ok(results.every(v => v.state === "booked" && v.participantConfirmation === "awaiting_responses"));
    assert.equal(google.writes("POST").length, 2);
    assert.ok(google.writes("POST").every(c => c.url.searchParams.get("sendUpdates") === "all"));
    const event = google.events.get(results[0]!.providerEventId)!;
    event.attendees.forEach((a: Event) => { a.responseStatus = "accepted"; });
    assert.equal((await workflow.reconcile(scope, results[0]!.id)).participantConfirmation, "accepted");
    event.attendees[0].responseStatus = "declined";
    assert.equal((await workflow.reconcile(scope, results[0]!.id)).participantConfirmation, "declined");
  });
  it("preserves saved travel buffers across separate requests", async () => {
    const { workflow, google } = fixture(); const [first] = await proposed(workflow);
    await book(workflow, first.id);
    const [second] = await proposed(workflow, [{ ...slot, propertyId: 13, reference: "BON-13", start: "2026-09-20T10:35:00+01:00", end: "2026-09-20T11:00:00+01:00" }], "other-proposal");
    await assert.rejects(book(workflow, second.id), /conflict/);
    assert.equal(google.writes().length, 1);
  });
  it("creates a team event without attendees when invitations were not requested", async () => {
    const { workflow, google } = fixture(); const [viewing] = await proposed(workflow);
    const saved = await workflow.mutate(scope, { id: viewing.id, requestId: "without-invites", action: "book", explicitlyRequested: true });
    assert.equal(saved.state, "booked"); assert.equal(saved.participantConfirmation, "not_invited");
    assert.deepEqual(google.writes()[0]?.body.attendees, []);
    assert.equal(google.writes()[0]?.url.searchParams.get("sendUpdates"), "none");
  });
  it("blocks availability errors and genuine conflicts without writing", async () => {
    const { workflow, google } = fixture(); const [viewing] = await proposed(workflow);
    google.freebusyErrors = true;
    const unknown = await workflow.availability(scope, viewing.id);
    assert.equal(unknown.available, false); assert.equal(unknown.unknownCalendars.length, 1);
    await assert.rejects(book(workflow, viewing.id), /conflict/);
    google.freebusyErrors = false; google.busy = [{ start: "2026-09-20T09:15:00Z", end: "2026-09-20T09:45:00Z" }];
    await assert.rejects(book(workflow, viewing.id), /conflict/); assert.equal(google.writes().length, 0);
  });
  it("retries/restarts never duplicate an accepted booking", async () => {
    const { workflow, google, store } = fixture(); const [viewing] = await proposed(workflow);
    const booked = await book(workflow, viewing.id);
    const again = await book(new CalendarWorkflowService(store, config, google.fetch), viewing.id);
    assert.equal(again.providerEventId, booked.providerEventId);
    assert.equal(google.writes().length, 1);
    await assert.rejects(workflow.mutate(scope, { id: viewing.id, requestId: "booking-one", action: "book", explicitlyRequested: true, sendInvitations: false }), /different action details/);
  });
  it("reconciles a timeout after provider acceptance without another insertion", async () => {
    const { workflow, google } = fixture(); const [viewing] = await proposed(workflow);
    google.failWrite = "after";
    const saved = await book(workflow, viewing.id);
    assert.equal(saved.state, "booked"); assert.equal(saved.pending, undefined);
    await book(workflow, viewing.id); assert.equal(google.writes().length, 1);
  });
  it("retains uncertain state and refuses blind retries when timeout readback finds no event", async () => {
    const { workflow, google, store } = fixture(); const [viewing] = await proposed(workflow);
    google.failWrite = "before";
    const uncertain = await book(workflow, viewing.id);
    assert.equal(uncertain.state, "uncertain"); assert.match(uncertain.issue!, /does not prove/);
    google.failWrite = undefined;
    const retried = await book(new CalendarWorkflowService(store, config, google.fetch), viewing.id);
    assert.equal(retried.state, "uncertain"); assert.equal(google.writes().length, 1);
    const [other] = await proposed(workflow, [slot], "different-proposal");
    await assert.rejects(book(workflow, other.id), /operation is pending/);
  });
  it("persists uncertainty when readback itself fails and completes later reconciliation", async () => {
    const { workflow, google, store } = fixture(); const [viewing] = await proposed(workflow);
    google.failGet = true;
    assert.equal((await book(workflow, viewing.id)).state, "uncertain");
    google.failGet = false;
    const restarted = new CalendarWorkflowService(store, config, google.fetch);
    assert.equal((await restarted.reconcile(scope, viewing.id)).state, "booked"); assert.equal(google.writes().length, 1);
  });
  it("does not adopt, overwrite, delete, or replace a colliding provider event", async () => {
    const { workflow, google } = fixture(); const [viewing] = await proposed(workflow);
    google.collide = true;
    const uncertain = await book(workflow, viewing.id);
    assert.equal(uncertain.state, "uncertain"); assert.match(uncertain.issue!, /belongs to another event/);
    await workflow.mutate(scope, { id: viewing.id, requestId: "cancel", action: "cancel", explicitlyRequested: true });
    assert.equal(google.writes().length, 1);
  });
  it("protects concurrent bookings with the persisted calendar lock", async () => {
    const { workflow, google } = fixture(); const [viewing] = await proposed(workflow);
    let release!: () => void;
    google.blockInsert = new Promise<void>(resolve => { release = resolve; });
    const first = book(workflow, viewing.id);
    while (google.writes().length === 0) await new Promise(resolve => setImmediate(resolve));
    const concurrent = await book(workflow, viewing.id);
    assert.equal(concurrent.state, "uncertain");
    release(); assert.equal((await first).state, "booked"); assert.equal(google.writes().length, 1);
  });
  it("recovers a crashed pre-write lock and fences a late paused worker before it can write", async () => {
    const { workflow, google, store } = fixture(); const [viewing] = await proposed(workflow);
    let release!: () => void;
    google.blockAvailability = new Promise<void>(resolve => { release = resolve; });
    const paused = book(workflow, viewing.id);
    while (!google.calls.some(call => call.url.pathname.endsWith("/freeBusy"))) await new Promise(resolve => setImmediate(resolve));
    const lock = (await store.list<any>("system:google-calendar", "calendar_lock"))[0]!;
    await store.put("system:google-calendar", "calendar_lock", lock.id, { ...lock.data, createdAt: "2026-01-01T00:00:00Z" });
    const recovered = await workflow.reconcile(scope, viewing.id);
    assert.equal(recovered.state, "proposed");
    release(); await assert.rejects(paused, /changed concurrently/);
    assert.equal(google.writes().length, 0);
    google.blockAvailability = undefined;
    assert.equal((await book(workflow, viewing.id)).state, "booked");
  });
  it("reschedules the same event with ETag protection and preserves original attendee responses", async () => {
    const { workflow, google } = fixture(); const [viewing] = await proposed(workflow);
    const booked = await book(workflow, viewing.id);
    const replacement = { ...slot, start: "2026-09-20T10:15:00+01:00", end: "2026-09-20T10:45:00+01:00" };
    const moved = await workflow.mutate(scope, { id: viewing.id, requestId: "move-one", action: "reschedule", explicitlyRequested: true, replacement });
    assert.equal(moved.state, "booked"); assert.equal(moved.start, replacement.start); assert.equal(moved.providerEventId, booked.providerEventId);
    const patch = google.writes("PATCH")[0]!;
    assert.equal(patch.headers.get("If-Match"), '"1"'); assert.equal(patch.body.attendees, undefined); assert.equal(patch.url.searchParams.get("sendUpdates"), "all");
    assert.equal(patch.body.summary, undefined); assert.equal(patch.body.location, undefined); assert.equal(patch.body.description, undefined);
  });
  it("does not ignore another event overlapping its own existing interval during rescheduling", async () => {
    const { workflow, google } = fixture(); const [viewing] = await proposed(workflow);
    await book(workflow, viewing.id);
    google.externalEvents = [{ id: "other", start: { dateTime: slot.start }, end: { dateTime: slot.end } }];
    await assert.rejects(workflow.mutate(scope, { id: viewing.id, requestId: "move", action: "reschedule", explicitlyRequested: true, replacement: slot }), /conflict/);
    assert.equal(google.writes("PATCH").length, 0);
  });
  it("retains the previous booking on provider version conflict and does not retry the same rejected operation", async () => {
    const { workflow, google } = fixture(); const [viewing] = await proposed(workflow);
    await book(workflow, viewing.id); google.failWrite = "precondition";
    const input = { id: viewing.id, requestId: "move", action: "reschedule" as const, explicitlyRequested: true, replacement: { ...slot, start: "2026-09-20T11:00:00+01:00", end: "2026-09-20T11:30:00+01:00" } };
    const rejected = await workflow.mutate(scope, input);
    assert.equal(rejected.state, "booked"); assert.equal(rejected.start, slot.start); assert.equal(rejected.lastOperation?.result, "rejected");
    google.failWrite = undefined; await workflow.mutate(scope, input); assert.equal(google.writes("PATCH").length, 1);
  });
  it("an old action retry cannot undo a more recent reschedule", async () => {
    const { workflow, google } = fixture(); const [viewing] = await proposed(workflow);
    await book(workflow, viewing.id);
    const first = { id: viewing.id, requestId: "move-one", action: "reschedule" as const, explicitlyRequested: true, replacement: { ...slot, start: "2026-09-20T11:00:00+01:00", end: "2026-09-20T11:30:00+01:00" } };
    const second = { ...first, requestId: "move-two", replacement: { ...slot, start: "2026-09-20T12:00:00+01:00", end: "2026-09-20T12:30:00+01:00" } };
    await workflow.mutate(scope, first); await workflow.mutate(scope, second);
    const retried = await workflow.mutate(scope, first);
    assert.equal(retried.start, second.replacement.start); assert.equal(google.writes("PATCH").length, 2);
  });
  it("reconciles cancellation after a timeout and sends one cancellation update", async () => {
    const { workflow, google } = fixture(); const [viewing] = await proposed(workflow);
    await book(workflow, viewing.id); google.failWrite = "after";
    const input = { id: viewing.id, requestId: "cancel", action: "cancel" as const, explicitlyRequested: true };
    const cancelled = await workflow.mutate(scope, input);
    assert.equal(cancelled.state, "cancelled"); assert.equal(cancelled.pending, undefined);
    await workflow.mutate(scope, input);
    assert.equal(google.writes("DELETE").length, 1); assert.equal(google.writes("DELETE")[0]?.url.searchParams.get("sendUpdates"), "all");
  });
  it("rejects reuse of a proposal ID with conflicting details", async () => {
    const { workflow } = fixture(); const first = await proposed(workflow);
    assert.equal((await proposed(workflow))[0]?.id, first[0]?.id);
    await assert.rejects(proposed(workflow, [{ ...slot, propertyId: 55 }]), /different viewing details/);
    await assert.rejects(proposed(workflow, [slot, { ...slot, start: "2026-09-20T11:00:00+01:00", end: "2026-09-20T11:30:00+01:00" }]), /different viewing details/);
  });
  it("refreshes OAuth using the server refresh token and checks granted scopes", async () => {
    const google = new FakeGoogle(); const oauthConfig = { ...config, accessToken: undefined, clientId: "client", clientSecret: "secret", refreshToken: "refresh" };
    const client = new GoogleCalendarClient(oauthConfig, google.fetch);
    await client.getEvent("team@example.test", "abc"); await client.getEvent("team@example.test", "abc");
    assert.equal(google.calls.filter(c => c.url.hostname === "oauth2.googleapis.com").length, 1);
    assert.equal(google.calls.at(-1)?.headers.get("Authorization"), "Bearer synthetic-refreshed");
    google.oauthScope = "https://www.googleapis.com/auth/calendar.readonly";
    await assert.rejects(new GoogleCalendarClient(oauthConfig, google.fetch).getEvent("team@example.test", "abc"), /Authorize calendar.events/);
  });
});
