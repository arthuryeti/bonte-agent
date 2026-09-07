# Bonte agent workflow implementation plan

Status: implementation completed for the available contracts, 7 September 2026; deployment and live write validation are pending. See [setup and validation](agent-workflows-setup.md) for required migration, configuration and remaining external inputs. The original design below is retained for traceability.

## Objective and evidence

Make the five requested workflows complete useful business tasks with verifiable results. Use the existing chat, gateway, PostgreSQL storage and Casafari CRM connection.

This plan is based on all 15 paths in the bundled Swagger 2.0 specification, `api.json`, the current implementation, and the previously reviewed 73 user messages. The specification identifies itself as “External Api Version”, v1, with a development hostname; the client currently defaults to `crmapi.casafaricrm.com`. A documented capability is not proof that the production account has permission or that every documented field is populated. Production contract checks are an implementation prerequisite, not something performed for this plan.

The main architectural change is to provide tools for the actual workflows, with validated inputs and computed results. The current `call_crm_api` exposes arbitrary endpoint/body combinations with brief descriptions. That leaves request construction and business rules to the model. Keep the HTTP client underneath explicit workflow tools; keep unsupported operations out of the agent's advertised capabilities.

## What the bundled API supports

| Area | Documented support | Boundary or dependency |
|---|---|---|
| Lead monitoring and audits | `POST /api/Leads/List`: opportunity status, dates, origin, description, agents, customers, associated properties and events. | No name/email/agent filter or pagination in the request schema. No explicit event-completed or email-delivered field. No endpoint to create reminders or update follow-up events. |
| Property search and buyer matching | `POST /api/Property/ListProperties`: reference/IDs, business type, property type, location, budget, bedrooms, bathrooms, areas, features, availability, sold status and agent. | Public listing URL is absent from the documented property response. External Casafari market search is absent. Buyer profiles can be written during lead insertion, but the lead-list response does not return a structured profile. |
| Brochures, emails and NDA drafts | Property descriptions, photos, features, agent details and file references support source-grounded brochures and emails. Local brochure generation already exists. | Email delivery, NDA generation and uploaded-document processing are application capabilities, not Casafari endpoints. |
| Contact checks and registration | Lead insertion includes contact details, a buyer profile, source/status assignment and agent assignment. `GetAgents` searches agents. `GetOwnerlinks` links property IDs to owner IDs. | No general customer/developer directory search or dedicated contact update/create endpoint. Owner links contain `PropertyId`, `OwnerId`, `CreateDate`, `OwnerLinkUrl`; they do not expose owner contact details. |
| Viewings and sales reporting | Lead events can supply viewing-related data. Opportunities include `Outcome`, `OutcomeDate`, `SalePrice`, agents and properties. | No appointment creation/calendar endpoint. Outcome semantics, completeness and broker attribution require validation before reporting closed sales. |

Two corrections to assumptions in the old conversations matter:

- `CodeTable` documents business types, property types and zones only. It does **not** document lead source/status/event dictionaries. Fixing that endpoint alone would not establish every ID needed for lead creation.
- `/api/Property/Hit` takes only an IP address and property ID. Its “Insert Property Visit” label does **not** establish support for booking physical viewings.

## 1. Lead monitoring and follow-up audits

### Intended workflow

Support recent leads, source filters, broker workloads, ageing enquiries, CRM-wide follow-up audits and configurable recurring monitoring. Each flagged lead should show the relevant broker/property, dated evidence, reason for attention and a useful next step or reminder draft.

### Implementation

1. Add a lead data service that retains full opportunity descriptions and events before producing a bounded answer. Compute requested totals over the available full dataset in application code; return compact evidence to the model. Do not derive CRM-wide percentages from 20 or 100 selected records.
2. Support the documented request filters: `Language`, `StartDate`, `EndDate`, `Category` (`Sales` or `Listings`) and `OriginId`. Perform name, normalized email/phone, broker, status and outcome filtering locally over the fetched data. Validate what the server's date filters actually mean before using them for historical windows.
3. Introduce an evidence-based classification: recorded contact, scheduled activity, attention needed, closed opportunity, and insufficient evidence. An event start/end time proves scheduling only unless a validated event type or explicit record establishes completed contact. `Recebido`, assignment and `LastUpdate` alone must never prove that someone was or was not contacted.
4. Make first-response targets, inactivity thresholds and working hours configurable. Report “no recorded contact in the available CRM history” where that is what the evidence establishes. Clearly identify incomplete history and ambiguous activity.
5. Persist audit runs, findings, monitored scopes and local follow-up tasks. Add a durable background job for monitors that survives gateway restarts and prevents duplicate runs/notifications. Show new or changed actionable findings in Bonte; broker reminders remain drafts unless sending has been explicitly requested and configured.
6. Replace the current follow-up action's open-ended CRM instruction with an actual persistent Bonte task, linked to the CRM lead. Add calendar synchronization only through the chosen calendar integration.

### Completion criteria

- “Which broker follow-ups are overdue?” returns dated evidence and a clear coverage statement.
- “How many leads never got answered?” distinguishes recorded evidence from unknown/offline communication and uses an explicit denominator.
- A scheduled follow-up persists, reappears after restart and triggers at its intended time.
- First-response durations are calculated only where completed contact and timestamps can be established; ambiguous records are reported separately.

## 2. Property searches and buyer matching

### Intended workflow

Turn a buyer brief into an accurate shortlist with reasons, photos, exact references and verified public links. Preserve that selection when the user asks for an email or brochure.

### Implementation

1. Add a typed property-search tool using the specification's actual enums and filters. Use structured locations resolved through `Location`/`InnerLocations` where practical. `FreeText` searches titles, addresses and other fields too, so it is not a strict city filter.
2. Support property type, sale/rent, price, exact or ranged bedrooms, areas, active/sold/published status and features such as `Pool`, `Garage`, `Lift`, `Terrace`, `RoofTerrace` and `SeaViews`.
3. Verify returned records against mandatory criteria. Exclude known failures; identify unknown features separately. Never quietly substitute apartments for villas, broaden the city or exceed a maximum budget.
4. Add one exact-property resolver shared by cards, photos, brochures and email drafting. Verify `reference`/`propertyId` in the response rather than selecting the first record. If both identifiers are supplied, require them to identify the same record. Retain source time and property identity throughout follow-ups.
5. Keep ordinary searches paginated. For explicit complete exports or matching jobs, process all relevant pages in the service and show a bounded ranked answer, with truthful coverage/counts after any local filtering.
6. Introduce durable buyer briefs with budget, locations, business type, property types, bedrooms and mandatory/preferred features. Persist explicitly supplied criteria in Bonte. Distinguish them from tentative preferences inferred from a previous enquiry; the latter must not silently become mandatory facts.
7. Match mandatory criteria first, then rank softer preferences. Explain each match and each unknown. An empty exact-match set should produce an honest result and optional alternatives clearly described by their deviations.
8. Build a verified mapping from CRM references/IDs to canonical website URLs using an available website CMS/feed or sitemap plus page verification. Do not generate plausible-looking slugs. Validate user-supplied listing links against the property identity.

### Dependencies and completion criteria

- “House with a pool in Cascais under €3M” returns only verified matches as exact matches.
- The same property facts appear in the card, photos, PDF and email.
- “All active buyers and what they want” uses available CRM evidence plus stored briefs, with completeness and inferred preferences marked.
- External Casafari inventory needs a separate search API/data feed and account permission. `CasafariGo/GetUrl`, `CreateUser` and `DeleteUser` only document access provisioning. This part cannot be completed with the bundled specification alone.

## 3. Brochures, emails and documents, including NDAs

### Brochures and emails

1. Keep and strengthen the existing branded property PDF generator. Feed it the verified property resolver, selected language, accurate photos, price-visibility rules and available listing files.
2. Add structured email drafts: recipient, subject, body, language/tone, selected properties, verified URLs and attachments. Support prospecting, replies to pasted enquiries and viewing requests. Allow conversational editing without losing the chosen property or inventing facts/availability.
3. Return reusable drafts and downloadable documents. If email sending is later included, it needs its own provider connection and an explicit send instruction; drafting an email is not evidence of sending it.

### NDA document workflow

Confirmed with the user: Bonte has an existing NDA template. Use that template and require additional user-supplied documents identifying the parties and the transaction before drafting. Bonte's template is reusable organizational configuration; users should not need to upload it for every NDA. The precise accepted document types and required extracted fields will be configured when the template and sample supporting documents are supplied.

1. Add upload support for PDF, DOCX and image scans, tied to the authenticated workspace and conversation. Extract text and use OCR for scanned inputs. Show unreadable/missing pages rather than fabricating their contents.
2. Build a configurable NDA intake checklist based on the agreed document types. Extract party names, relevant identification/company details, signatory capacity and transaction/purpose details, retaining document/page references. Collect agreement choices such as language, confidentiality period and jurisdiction explicitly when absent from the supplied material.
3. Require all mandatory documents and facts before producing a completed NDA draft. Ask only for missing or conflicting items. The existing conversation should retain usable uploaded inputs across turns.
4. Populate the supplied template while preserving its clauses and structure. Distinguish facts taken from documents from terms supplied in chat. Do not invent identifiers, party authority, dates or commercial/legal terms.
5. Produce an editable DOCX and a rendered PDF draft with checked pagination, tables and signature blocks. Version revisions and associate the output with its source documents/template version.
6. Extend the current generated-file route into an attachment service with ownership checks, upload limits, explicit retention/deletion and durable storage. Current downloads are authenticated but addressed by filename; sensitive uploaded documents require authorization per attachment, not merely a valid login.

### Completion criteria

- A brochure is generated for the verified requested property and can be downloaded again from history.
- “Make this more human and elegant” revises tone while retaining verified listing facts and links.
- An NDA request first requests the agreed missing documents; readable supplied documents and complete intake produce a usable DOCX/PDF draft. An unreadable or conflicting input produces a targeted follow-up.
- Another user's workspace cannot retrieve the documents or their extracted contents.

## 4. CRM contact checks and registration

### What is feasible

`Leads/Insert` documents a concrete request structure:

- `Settings`: `LeadTitle`, `AssignToPropertyId`, `AssignToStatusId`, `AssignToCustomerOriginId`, assignment rules, `ForceAgent.AgentId`/`AgentEmail`, mailing and opt-in flags.
- `Contact`: `Name`, `Email`, `Phone`, `Message`, address/location, culture/country/nationality, and one `Type`: `Buyer`, `Renter` or `Seller`.
- `Contact.Profile`: bedroom, bathroom, budget and area ranges, property types, regions/cities/localities/zones, `Note` and `ForceNewProfileToExistingContact`.

The buyer-profile fields directly support much of the observed penthouse registration request. The profile's additional requirements, such as elevator and outdoor space, can be retained in `Note` and the structured Bonte brief when no matching structured CRM field exists.

### Implementation

1. Add an intake parser for pasted emails/messages and a schema-validated lead-registration tool. Resolve property references to verified numeric IDs and broker names to verified agents. Ask only about ambiguity or required missing information.
2. Check normalized email/phone against the full available lead dataset before inserting. Distinguish an existing contact from an existing opportunity: the same person can legitimately enquire about another property. Do not present a lead-history search as an exhaustive search of every CRM contact.
3. Obtain tenant-specific source/status IDs and validate a known-working insertion example with Casafari or an authorized test environment. The specification does not fully document required server-side combinations; do not guess IDs or vary production payloads until one succeeds.
4. Validate `Success`, `Errors`, `Warnings` and a returned `LeadId`, not just HTTP status. Read back the resulting lead where available. Persist action IDs so request retries or process restarts do not duplicate writes. After an uncertain timeout, reconcile the outcome before considering another insertion; `CorrelationId` is not documented as an idempotency guarantee.
5. Preserve all required buyer criteria. Validate the meaning and duplicate behavior of `ForceNewProfileToExistingContact` before using it. Existing-record profile changes are not assumed to be available through a general update endpoint.
6. Resolve the “seller + buyer” case explicitly: the documented `Contact.Type` is a single enum value. Keep both intents in the local brief and notes, and validate the CRM's supported multi-profile workflow before creating additional records. Never silently discard one intent or create two contacts.
7. For developers, search only the sources actually available: known lead customers and property-linked owner IDs. A positive match needs evidence; a negative result means no match in the searched scope. A complete developer/contact directory check requires a further entity-search endpoint, permission or CRM export, because `GetAgents` and `GetOwnerlinks` do not establish this capability.

### Completion criteria

- “Register this Instagram lead for this broker and property” creates one verified lead when required mappings are available, or identifies the exact missing field/dependency.
- Buyer requirements survive registration and can drive matching later.
- Retries do not create a second lead, and uncertain writes are not reported as successful.
- Developer searches report coverage accurately and never equate “not accessible” with “not registered”.

## 5. Viewing scheduling and sales reporting

### Viewing scheduling

1. Add a scheduling workflow covering property/participant resolution, date, explicit timezone, duration, consecutive-viewing travel buffers and notes.
2. Store proposed appointments in Bonte and connect the team's Google Calendar, as requested by the user. Configure the intended calendar IDs, authorized users and Google account access in the deployed application. A calendar connector available to the development assistant does not give the deployed Bonte agent access. Calendar conflicts can only be checked for calendars the application is authorized to read.
3. Check availability where access exists, then execute an explicitly requested booking. Persist provider event IDs and the request ID to support updates, cancellation, retries and restart recovery.
4. Track proposed, booked and participant-confirmed states separately. Creating an event does not prove that an owner or client accepted. A generated calendar file is an export, not a confirmed booking.
5. Use calendar invitations or a configured mail provider for requested communications. Where owner details are inaccessible through the CRM, collect them from the user rather than assuming `OwnerLinkUrl` exposes contact data.

### Sales reporting

There is a better starting point than the property `Sold` flag: `ListLeadsOpportunity` includes `Outcome`, `OutcomeDate`, `SalePrice`, `Agents` and `Properties`.

1. Inspect representative real records to establish the won/sold outcome values, date format/timezone, date completeness, price meaning and agent associations.
2. Compute historical reports from validated closed outcomes and `OutcomeDate`. Do not filter by lead creation date when the question asks for sales closing since January; an old lead may close in the requested period.
3. Report closed opportunities and linked properties with source IDs, dates, broker associations and amounts when populated. Deduplicate opportunities by ID. Avoid counting each linked property or agent as another sale, and do not double-count shared-agent amounts in organization totals.
4. Explicitly separate linked-property counts, won-opportunity counts and verified transactions. The documented schema has no dedicated transaction ID or role-specific closing attribution. Until those semantics are established, label the result as a CRM outcome report rather than an authoritative sales/commission ledger.
5. When an outcome date is absent, list the record under missing-date exceptions. Never substitute property creation/modification dates. Use a CRM transaction export or additional endpoint for gaps in authoritative production reports.

### Completion criteria

- A viewing is called booked only after the selected calendar provider confirms creation; attendees' responses remain distinct.
- A two-property schedule preserves order, timezone and travel buffer through edits.
- “What has this broker sold since January?” uses the relevant closing evidence and exposes missing dates/attribution rather than returning all historically sold listings.

## Shared implementation work

| Component | Planned responsibility |
|---|---|
| CRM adapter | Validated request/response shapes, documented enums, application-level error handling, pagination, rate/timeout controls, capability checks. |
| Workflow tools | Search, exact-property resolution, lead queries/audits, buyer matching, registration, drafts, NDA intake, scheduling and sales outcomes. Models phrase answers; code validates identities and computes counts. |
| Persistence | Scoped source snapshots/coverage, explicit buyer briefs, audit results, local tasks and durable job state, workflow/action records, attachments, draft versions and calendar event references. Store only fields needed for each workflow; do not ingest unrelated customer identifiers for audits. |
| Chat and gateway | Structured results, actionable missing-input prompts, uploads, draft editing, persistent outcomes and reliable retry behavior. Carry authenticated workspace/actor context into tools. |
| Background work | CRM refreshes with truthful freshness, monitor runs, due reminders and reconciliation. Checkpoints/backoff and persistent deduplication; no new scheduler service is required until scale justifies it. |
| Capabilities | Show what is enabled, unavailable, awaiting setup or temporarily failing. A connector error should not become “no results” or “completed”. |

Existing user instructions and permissions should carry through the workflow. Do not introduce confirmation for every read or draft. Ask when required input is missing or ambiguous, required NDA documents have not arrived, or an external send/book action has not been requested. This plan does not authorize sending messages, booking real viewings or creating test records in production now.

## Delivery sequence

| Phase | Deliverable | Dependencies / exit criteria |
|---|---|---|
| 0. Validate contracts and access | Read-only checks of the actual tenant, filter/date semantics, populated event/outcome fields and current permissions; capability matrix; collect working insertion examples and required ID mappings. | Establish which capabilities are supported and list exact vendor/admin inputs. Use an authorized test environment or an explicitly requested real registration for write verification. Do not let a blocked connector delay independent work. |
| 1. Reliable CRM data and answers | Typed services, exact property resolution, full-data lead analysis, truthful coverage, property filters and error handling. | Original search and audit examples pass against controlled records; no invented identity, full-dataset totals from a preview, or status-to-contact assumptions. |
| 2. Lead operations | Durable follow-up tasks/monitoring, contact lookup within known scope, validated registration, stored buyer criteria, initial outcome-based sales reporting. | Duplicate/uncertain writes handled, jobs survive restarts, and date/attribution exceptions are visible. Registration and authoritative sales reporting remain gated by their concrete data dependencies. |
| 3. Matching and shareable materials | Ranked buyer matching, website link mapping, consistent brochures, editable email drafts. | Verified shortlist → correct links/photos → matching PDF/email, including conversational edits. |
| 4. NDA intake and documents | Uploads, text extraction/OCR, party/transaction-document checklist, Bonte template population, DOCX/PDF output and attachment access controls. | Bonte's template and required source fields are configured; complete inputs produce rendered, usable drafts. |
| 5. Calendar completion and additional data sources | Team Google Calendar booking, updates/cancellation and requested invitations; external inventory and general contact lookup if their APIs/exports are supplied. | Actual provider confirmations and event IDs; unsupported external sources remain explicitly pending rather than simulated. |

## Validation approach

Turn the observed message sequences into regression scenarios using synthetic/redacted records, not personal details committed to the repository. Exercise business outcomes, not exact wording.

Required cases include: a misleading `Recebido` status with recorded contact; a scheduled-but-uncompleted call; an old lead closing this year; incomplete event history; wrong-reference API results; apartment/villa and pool-filter mismatches; truncated searches; conflicting buyer requirements; existing contact with a new opportunity; uncertain insertion retries; unavailable owner data; an NDA with missing/unreadable documents; unauthorized attachment access; calendar retry/reschedule conflicts; and a two-property appointment.

Run unit/integration checks for the services and state transitions, mocked provider contracts, staging smoke checks for enabled integrations, web interaction checks for the affected flows, and visual render checks for generated documents. A workflow is complete when its promised outcome is verified, not when the agent returns a plausible response. A useful fallback is still a fallback and must not count as full completion of an unavailable capability.

## Confirmed choices and remaining inputs

Confirmed: use Bonte's existing NDA template and require supporting party/transaction documents; save viewings in the team's Google Calendar.

1. Bonte's template and representative supporting documents, so required identity/transaction fields and accepted document types can be configured. The intended workflow is settled; these are implementation inputs.
2. The target Google Calendar IDs, authorized account access and invitation sender; any separate email-sending workflow will also need its sender configured.
3. Business definitions for follow-up targets, working hours, closed outcomes and broker attribution; these can be configurable rather than hard-coded.
4. A trusted source for public listing URLs.
5. Casafari/admin inputs: valid source/status mappings and a known-working lead insertion example; any available general contact directory, external market search and transaction reporting endpoints/exports; owner-link permission if that limited lookup is useful.

## Source map

These are pre-implementation references, describing the code as inspected when writing this plan; source-file line numbers and behavior have since changed.

- `api.json:322`: lead insertion endpoint; `2664`: settings; `2699`: contact; `2999`: buyer profile; `3158`: lead-list request filters.
- `api.json:3282`: opportunity/outcome fields; `3426`: lead event fields.
- `api.json:4119`: property search filters; `4739`: property response and source facts; `5533`: hit request.
- `api.json:2207`: actual code-table response; `2607`: limited owner-link fields.
- `src/tools/crm.ts`: generic tool, default 20-lead limit, 100-lead tool maximum, omitted descriptions and three-event summaries.
- `src/pdf/property-data.ts:221`: existing brochure lookup takes the first result without verifying its identity.
- `src/gateway/websocket-server.ts:468`: current follow-up control submits an instruction rather than saving an appointment/task.
- `web/app/api/chat/route.ts`: current text-only incoming chat handling; `web/app/api/files/route.ts`: authenticated filename-based output downloads.
- `web/lib/db/schema/gateway.ts`: current conversation/message storage, to be extended for workflow state.
- `output/analysis/bonte-agent-usage-2026-09-07.md`: local, redacted usage analysis and message evidence; ignored by Git.
