# Bonte agent workflows: setup and verification

Implemented against the bundled Casafari contract. This release has not been deployed and has not created live leads, calendar events or invitations.

## Enable the release

1. Back up the application database and apply `npm --prefix web run db:migrate` using the intended deployment database. The new `0002_wakeful_logan.sql` migration adds `workflow_records`; it does not replace chat/auth tables. The gateway refuses to start without this schema. The migration was tested on an isolated PostgreSQL engine, not applied to production during development.
2. Deploy the gateway and web together. Preserve the existing `agent-output` volume: it now holds protected attachments as well as brochures. Metadata, action IDs, drafts, buyer briefs, follow-ups and monitoring state live in PostgreSQL. Back up database and files together. Do not serve `output/private` as static content. Older brochures can migrate on first download only when that workspace's saved assistant attachment metadata proves ownership; their original retention deadline is preserved, and deleted/expired protected files cannot be revived.
3. Use the updated gateway Docker image for Poppler, Tesseract (English/Portuguese), and LibreOffice Writer. For local development install those executables, or set their `BONTE_*_PATH` overrides from `.env.example`. DOCX extraction and template population use installed npm dependencies.
4. Ask the agent for workflow status while signed in. It reports this user's workspace/actor IDs and missing configuration. Ordinary CRM reads, local tasks, proposals and email drafts do not require enabling CRM writes or Calendar access.

Uploads accept PDF, DOCX and image scans with bounded file/page/extraction limits. Each upload belongs to its authenticated workspace and conversation. Source documents and generated files default to 30-day retention (`BONTE_ATTACHMENT_RETENTION_DAYS`); users can delete them sooner. The background worker removes expired files, derived document drafts and expiring notifications/audit results. It runs inside the gateway every 30 seconds; there is no extra scheduler service. Follow-ups and monitor definitions persist until explicitly completed/cancelled. Due reminders and changed audit findings appear in Bonte, without sending email or broker messages.

The existing application uses a separate workspace for each signed-in user. Conversations, briefs, drafts, tasks and viewing records follow that boundary. This release does not introduce shared team chat history.

## CRM semantics and registration

Read-only tenant checks returned 6,546 leads and 508 property candidates on 7 September 2026. No lead returned an `Events` history. Audits therefore report missing evidence/review candidates; they cannot prove that those leads were never answered. Fifty leads had `Outcome=Won`; amounts included rental-sized values. Reports label these as closed CRM opportunities, with date/amount/attribution exceptions, rather than verified sales or commissions. Property identity in the live response uses numeric `id`, which the shared resolver supports. `CodeTable` returned HTTP 500 with the documented query flags.

Confirm and configure:

- `CRM_TIMEZONE`: the timezone of CRM timestamps that omit an offset. Do not assume the server uses the browser's timezone. Explicit-offset values work without this setting; unresolvable or ambiguous dates remain exceptions.
- `CRM_FIRST_RESPONSE_HOURS` and `CRM_INACTIVITY_HOURS`: default 24 and 168 calendar hours. Optional `CRM_BUSINESS_HOURS_JSON` defines `{timeZone,weekdays,startHour,endHour}` for a validated working-hours policy.
- Completed-contact evidence: `CRM_COMPLETED_CONTACT_EVENT_TYPE_IDS_JSON` and/or `CRM_COMPLETED_CONTACT_EVENT_TYPES_JSON`. Leave empty until their semantics are confirmed. `CRM_EVENT_HISTORY_COMPLETE` defaults false. Assignment, status and a scheduled event are not contact completion.
- `CRM_CLOSED_OUTCOMES_JSON` and `CRM_WON_OUTCOMES_JSON`: default `["Won"]`; set actual tenant meanings. `CRM_PROPERTY_ACTIVE_STATUSES_JSON` defaults to the exact observed `Active` status mapping.

Registration remains gated until all three are present: `CRM_LEAD_INSERT_VALIDATED=true`, a verified positive `CRM_LEAD_STATUS_ID`, and `CRM_LEAD_ORIGIN_IDS` mapping source names to verified positive IDs. Obtain a known-working tenant insertion example from Casafari/admins and validate it in an authorized test environment before enabling the flag. Code tables do not supply these mappings. No production insertion was attempted during implementation.

Registration checks available lead history for normalized email/phone matches, resolves the requested property/broker, preserves buying requirements and stores durable action/target claims. An uncertain response is reconciled before another write; changing the prompt or action ID cannot silently repeat the same pending contact/property insertion. Existing profile updates and combined buyer/seller intent are returned as explicit unresolved intake, not guessed CRM operations. Free-text buying requirements must be structured before saved-brief matching can claim exact matches.

`npm run crm:check` repeats read-only contract diagnostics and prints aggregate counts/shapes without contact records. It uses the configured tenant credentials.

## Verified listing URLs

Property search and matching enforce mandatory criteria and separate unknowns from exact matches. External Casafari market inventory is not in this API.

For public links, configure `CRM_LISTING_SOURCE_URL` with an approved HTTPS JSON feed or sitemap and `CRM_LISTING_ALLOWED_HOSTS` with exact hostnames. Run `npm run crm:sync-links` from an administrator checkout. The feed format is `[{"reference":"A-42","propertyId":42,"url":"https://your-approved-host/..."}]`. Each destination page must expose matching explicit reference/CRM-ID metadata or a reference label; paths are not guessed. The sync reports rejected/ambiguous pages and bounded coverage.

Set `CRM_LISTING_URLS_PATH` to the resulting JSON file in the deployed gateway; for example, place it on the existing output volume at `/app/output/verified-listing-links.json`. Re-run sync when website inventory changes. Default sync cap is 1,000 pages (`CRM_LISTING_SYNC_MAX_PAGES`). No real website source was supplied or synced during implementation.

## Bonte's NDA template

The default is now the supplied four-page `templates/nda/NDA_BonteFilipidis_Template2026_pt.pdf`, preserved byte-for-byte with SHA-256 `518bc1e2c62d066d985ade8f010e69960e5bafa8712b0ba6a7f9c048b5c86f01`. The gateway image includes it and `templates/nda/nda.json`; leave `BONTE_NDA_CONFIG_PATH` unset to use it. No LibreOffice conversion is involved for this PDF.

Generation adds six editable PDF fields: the complete date, receiving party's legal name and address, represented entity/person, signatory name and title. Clauses, logo, pagination and both signature lines remain as supplied. Users can edit the downloaded fields in a form-capable PDF reader and save a copy, or clarify sourced facts in chat to generate a new revision. Downloaded edits do not update the stored intake. Clause editing is not provided by these fields.

The source date prints **2025** despite the 2026 filename. The date widget covers that area with the user's explicitly chosen full Portuguese date; no year is assumed. This is an overlay, so underlying source text still contains 2025. The original footer's **AMI 1384** versus the body's **13824** is preserved and surfaced for review. The retained party/transaction document requirements still apply; the template does not add transaction-specific clauses or require invented duration/jurisdiction terms.

Fields use 7–9 pt text and reject overflow, newlines and characters the PDF font cannot display before publishing a draft. Long legal names or addresses that cannot fit need a shorter approved value or a revised template. The PDF remains unsigned. The source checksum prevents silently applying field positions to a different PDF.

For an approved replacement, place the template and its JSON configuration on the private `workflow-config` volume mounted at `/app/config:ro`, and set `BONTE_NDA_CONFIG_PATH=/app/config/nda.json`. DOCX templates remain supported and produce editable DOCX plus LibreOffice-rendered PDF. The following illustrates custom DOCX configuration, not the bundled PDF's actual fields:

```json
{
  "version": "bonte-approved-version",
  "templatePath": "approved-nda.docx",
  "title": "Bonte NDA draft",
  "requiredDocuments": [
    { "category": "party", "label": "Party identification", "minimum": 2 },
    { "category": "transaction", "label": "Transaction details", "minimum": 1 }
  ],
  "fields": [
    { "key": "party_one_name", "label": "First party legal name", "source": "party", "required": true, "maxLength": 500 },
    { "key": "transaction_purpose", "label": "Transaction purpose", "source": "transaction", "required": true },
    { "key": "language", "label": "Language", "source": "agreement", "required": true, "allowedValues": ["English", "Portuguese"] }
  ]
}
```

An administrator must adapt fields and document counts to Bonte's approved template and representative supporting documents. Use flat placeholders such as `{party_one_name}` in the DOCX while preserving its approved clauses, tables and signature blocks. Agreement choices come from the user; party and transaction facts require document/page evidence. Missing, unreadable or conflicting evidence stops draft completion and produces a targeted request. Template loops, arbitrary replacements and invented clauses are unsupported.

The exact PDF tests use two fictional Portuguese examples, including longer names/addresses and accents, and an editable save/reopen example. They verify all four original page content streams, field values and appearances, signature preservation, evidence-backed revisions, and rejection of overflow/unsupported characters/changed templates. Run `node --import tsx --test test/document-workflows.test.ts`; optionally set `BONTE_NDA_TEST_OUTPUT_DIR=output/pdf/nda-template-tests` to retain the three review PDFs. These are test documents, not client agreements.

Visual QA rendered all three PDFs with Poppler and checked their fields. All four pages were pixel-identical to the source outside the six field rectangles (with a two-pixel antialiasing margin). Independent pypdf checks confirmed six editable canonical fields, matching widget values and non-empty appearances in each saved output. The full suite passed **192 tests**, with zero failures and one optional external-PostgreSQL test skipped; the backend build passed. This change has not been deployed.

Structured email drafts are saved and revised separately, with selected property identities and attachments retained; no email provider or sending feature was added.

## Team Google Calendar

Configure a Google OAuth client and authorize the intended team account with `https://www.googleapis.com/auth/calendar.events` and `https://www.googleapis.com/auth/calendar.readonly` (or the broader calendar scope if already approved). Grant that account access to the selected team calendars. Store `GOOGLE_CALENDAR_CLIENT_ID`, `GOOGLE_CALENDAR_CLIENT_SECRET` and an offline `GOOGLE_CALENDAR_REFRESH_TOKEN` in deployment secrets.

Set `GOOGLE_CALENDAR_ALLOWED_IDS` to canonical calendar IDs (`primary` is rejected because aliases could bypass shared-calendar locking), `GOOGLE_CALENDAR_WORKSPACE_IDS` to the allowed Bonte workspace IDs and `GOOGLE_CALENDAR_AUTHORIZED_ACTOR_IDS` to authorized actor IDs (comma-separated). Obtain IDs using `calendar_workflow_status` from each intended user's signed-in chat; they are Bonte scope IDs, not emails or raw authentication IDs. The legacy singular `GOOGLE_CALENDAR_WORKSPACE_ID` is also supported. The development assistant's Google connection does not authorize the deployed application.

The agent can save proposals before Google is connected. Booking checks accessible calendars, explicit timezone/DST, consecutive-viewing order and travel buffers. Only a confirmed provider event is called booked. Attendee responses remain separate; invitations are sent only when requested. Retries, reschedules and cancellations retain the same event ID and reconcile uncertain writes. Availability checks and event creation are separate Google operations, so another calendar client can still book between them. Bonte serializes its own writes to a shared calendar; it cannot lock Google Calendar globally.

Access is bounded to 100 configured workspaces and 10,000 saved viewing records per workspace; hitting the record cap blocks booking until coverage is resolved. Provider behavior was exercised with controlled HTTP responses. A real authorized booking/reschedule/cancel smoke check remains necessary after account setup. No live events or invitations were sent during development.

## Validation and remaining data gaps

Final run: **190 passed, zero failed, one optional external-PostgreSQL chat-persistence test skipped**. The new workflow migration/rollback and legacy ownership SQL checks run unconditionally against isolated PostgreSQL via PGlite. Backend and production web builds and Drizzle migration checks passed.

Run `npm test`, `npm run build`, `npm run build:web`, and `npm --prefix web run db:check`. Tests cover exact identity/criteria, truthful coverage, missing event evidence, local outcome-date boundaries, duplicates and uncertain writes, task races/restarts, actual workflow SQL migration/rollback, document extraction and ownership, and Calendar mutation/reconciliation. HTTP/WebSocket tests use local sockets and isolated stores; no production writes are part of the suite. The production web build may fetch its existing Google Font dependency. Docker Compose configuration validates; a full container build was not run because the local Docker daemon was unavailable.

A configuration-only request through the configured Surplus/Claude agent successfully invoked `get_workflow_status` and returned an answer. This exposed and fixed the provider's empty-string serialization for no-argument tools: normalization applies only when the bound schema accepts `{}`; other malformed calls fail visibly.

The final read-only live smoke check passed property pagination, exact property identity, matching, all 6,546 returned lead audit classifications and outcome reporting. Ten browser interaction checks passed against the actual React upload/task components and stylesheet with mocked API responses; this included failed-action retries, upload cancellation on chat switches, selection persistence, completion and notification counts. The authenticated production browser session was not exercised.

General developer/customer directory lookup, external market inventory, authoritative transaction/commission reporting and email sending still need additional APIs/exports/provider contracts. Their absence is reported as unavailable coverage. They are not simulated by unrelated Casafari endpoints.
