# CRM DeepAgent

Barebones [DeepAgent](https://docs.langchain.com/oss/javascript/deepagents/overview) in TypeScript with a single tool that calls the Proppy CRM API.

Inspired by [Hermes Agent](https://github.com/NousResearch/hermes-agent), this project uses a **subscription-provider pattern** instead of hard-coding a single LLM vendor. You can switch between 200+ models (via OpenRouter, Together AI, etc.) or direct providers (OpenAI, Anthropic, DeepSeek, etc.) using only environment variables — zero code changes.

## Setup

1. Copy the environment template and fill in your keys:

   ```bash
   cp .env.example .env
   ```

2. Install dependencies:

   ```bash
   npm install
   ```

3. Run the agent:

   ```bash
   # With arguments
   npm run dev -- "List the latest leads"

   # Without arguments (uses default query)
   npm run dev
   ```

## Deploying with Coolify

This repository includes a production `Dockerfile` and a
`docker-compose.yml` configured for Coolify. The gateway is a background
worker that uses Telegram long polling and/or a WhatsApp WebSocket connection,
so it does not need a public domain or an exposed port.

### Create the Coolify resource

1. Push the repository to a private Git repository.
2. In Coolify, connect the repository with the GitHub App integration.
3. Create a new resource from the repository and select the `Docker Compose`
   build pack.
4. Use `/docker-compose.yml` as the Compose file and leave domains empty.
5. Fill in the environment variables detected from the Compose file. At
   minimum, set `LLM_PROVIDER`, `LLM_MODEL`, the matching provider API key,
   CRM authentication, and either `TELEGRAM_BOT_TOKEN` or
   `WHATSAPP_ENABLED=true`.
6. Keep API keys as runtime-only variables; they are not needed during the
   image build.
7. Enable **Auto Deploy** under the resource's advanced settings and deploy.

The image runs the test suite and TypeScript build before a deployment can
start. A failed test or build therefore leaves the previous deployment
running.

For WhatsApp, open the first deployment's runtime logs and scan the pairing QR
code. The `whatsapp-auth` volume preserves that pairing across deployments.
Generated PDFs are temporary container files because the gateway uploads them
to Telegram or WhatsApp immediately.

Do not commit `.env` or `.whatsapp-auth`. If `.env` was previously committed,
remove it from Git tracking with:

```bash
git rm --cached .env
```

If credentials were pushed to a remote repository, rotate them before
deploying.

## Subscription-Provider Pattern

Instead of calling OpenAI or Anthropic directly, the agent routes through a **provider abstraction**:

| Type | Providers | What you get |
|------|-----------|--------------|
| **Aggregators** | `openrouter`, `together`, `nous`, `huggingface` | One API key → 200+ models. Switch models by changing `LLM_MODEL`. |
| **Direct** | `openai`, `anthropic`, `deepseek`, `groq`, `ollama`, `zai`, `kimi-coding` (`kimi` / `moonshot` aliases) | Talk straight to the vendor's API. |

### Switching providers

Just change two env vars — no code changes, no reinstall:

```bash
# OpenRouter (aggregator)
LLM_PROVIDER=openrouter
LLM_MODEL=anthropic/claude-sonnet-4-5-20250929
OPENROUTER_API_KEY=sk-or-...

# Together AI (aggregator)
LLM_PROVIDER=together
LLM_MODEL=meta-llama/Llama-3.3-70B-Instruct-Turbo
TOGETHER_API_KEY=...

# OpenAI (direct)
LLM_PROVIDER=openai
LLM_MODEL=gpt-4o
OPENAI_API_KEY=sk-...

# Anthropic (direct)
LLM_PROVIDER=anthropic
LLM_MODEL=claude-sonnet-4-5-20250929
ANTHROPIC_API_KEY=sk-ant-...

# Local Ollama
LLM_PROVIDER=ollama
LLM_MODEL=llama3.2
OLLAMA_API_KEY=ollama

# Z.AI / GLM (Zhipu AI)
LLM_PROVIDER=zai
LLM_MODEL=GLM-5.1
ZAI_API_KEY=...

# Kimi Coding Plan / Kimi K3
LLM_PROVIDER=kimi-coding
LLM_MODEL=k3
KIMI_API_KEY=...
```

Kimi Code keys beginning with `sk-kimi-` automatically use the
Anthropic-compatible `https://api.kimi.com/coding` endpoint. The provider
defaults to `k3`, omits `temperature`, and accepts `KIMI_CODING_API_KEY` as an
alias. Legacy Moonshot keys continue to use the OpenAI-compatible
`https://api.moonshot.ai/v1` endpoint and default to `kimi-k2-latest`.
`KIMI_BASE_URL` always takes precedence over automatic endpoint selection.

### How it works

```
┌─────────────┐     ┌─────────────────┐     ┌─────────────────────────────┐
│   Agent     │────▶│ Provider Factory │────▶│ OpenRouter / Together / etc │
│  (deepagents)│     │ (registry + transport)│  │    (aggregator endpoint)     │
└─────────────┘     └─────────────────┘     └─────────────────────────────┘
                                                   │
                                                   ▼
                                              Any model you want
```

The factory (`src/providers/factory.ts`) resolves the provider from env vars, picks the right transport (`openai_chat` or `anthropic_messages`), and returns a LangChain model instance. `createDeepAgent` receives that instance and doesn't care where the model actually lives.

## Project Structure

```
src/
  index.ts              # CLI entry point (single-shot queries)
  gateway-server.ts     # Messaging gateway server (Telegram + WhatsApp)
  providers/
    types.ts            # Provider transport types
    registry.ts         # Provider configs (aggregators + direct)
    factory.ts          # Model factory — resolves env vars, builds LLM instance
  gateway/
    types.ts            # Platform, MessageEvent, GatewayConfig
    session.ts          # Per-chat conversation history store
    registry.ts         # Platform adapter registry
    gateway.ts          # Gateway orchestrator — routes messages ↔ agent
    platforms/
      base.ts           # BasePlatformAdapter abstract class
      telegram.ts       # Telegram adapter (Grammy)
      whatsapp.ts       # WhatsApp adapter (Baileys)
  tools/
    crm.ts              # LangChain tool wrapping the CRM API
    property-pdf.ts     # Tool that generates branded property PDF brochures
  pdf/
    property-data.ts    # Normalizes CRM property records for PDF rendering
    render-property-pdf.ts # PDFKit-based brochure renderer
  client/
    crm-client.ts       # Thin fetch-based HTTP client
```

## Messaging Gateway

Inspired by Hermes Agent's gateway, the project includes a **multi-platform messaging gateway** that lets you talk to the agent from Telegram and WhatsApp.

### Architecture

```
┌─────────────┐      ┌──────────┐      ┌─────────────┐
│  Telegram   │─────▶│          │      │             │
│   (Grammy)  │      │  Gateway │─────▶│  DeepAgent  │
└─────────────┘      │          │      │  + CRM Tool │
┌─────────────┐      │ (routes  │◀─────│             │
│  WhatsApp   │─────▶│  msgs)   │      └─────────────┘
│ (Baileys)   │      └──────────┘
└─────────────┘
```

### Running the gateway

```bash
# Start the gateway server
npm run gateway

# Or after building
npm run build
npm run start:gateway
```

### Configuration

Set the platform-specific env vars in `.env`:

```bash
# Telegram — get a token from @BotFather
TELEGRAM_BOT_TOKEN=123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11
TELEGRAM_ALLOWED_USERS=123456789,987654321  # optional
TELEGRAM_REQUIRE_MENTION=true               # optional (groups only)
TELEGRAM_TYPING_INDICATOR=true              # optional, defaults to true
TELEGRAM_STREAM_UPDATES=true                # optional, defaults to true

# WhatsApp — enables Baileys WebSocket connection
WHATSAPP_ENABLED=true
WHATSAPP_AUTH_DIR=.whatsapp-auth            # session persistence
WHATSAPP_ALLOW_FROM=351912345678            # optional phones/JIDs/LIDs; * allows all
WHATSAPP_REQUIRE_MENTION=true               # groups: mention, command, or reply to bot
WHATSAPP_DEBUG=false                        # verbose protocol diagnostics
WHATSAPP_SEND_TIMEOUT_MS=60000              # timeout for a stuck send
WHATSAPP_CHUNK_DELAY_MS=300                 # pacing between long-message chunks
WHATSAPP_MODE=bot                           # bot (customer chats) or self-chat (your own chat)
WHATSAPP_FORWARD_OWNER_MESSAGES=false       # bot mode: owner replies trigger human handover
WHATSAPP_HANDOVER_MINUTES=60                # suppress bot replies after owner activity
WHATSAPP_SEND_READ_RECEIPTS=false           # opt-in policy-aware read receipts
WHATSAPP_STREAM_UPDATES=true                # edit a live response while it streams
# WHATSAPP_REPLY_PREFIX=none                # optional: remove the self-chat prefix
# WHATSAPP_MAX_MESSAGE_LENGTH=4096          # optional text chunk size
```

**WhatsApp first-time setup:** On first run, Baileys prints a **QR code** to the terminal. Scan it with WhatsApp on your phone (Linked Devices → Link a Device). Credentials are saved to `WHATSAPP_AUTH_DIR` so you don't need to scan again.

Baileys reports disconnect `515` immediately after a successful first pairing;
this is the expected request to restart the socket, and the gateway reconnects
automatically. Disconnect `401` means WhatsApp removed or logged out the linked
device. The gateway clears only that revoked auth state, preserves the mounted
auth directory, and prints a fresh QR code. Keep a single gateway replica per
WhatsApp auth volume so two sockets do not compete for the same linked device.

`WHATSAPP_MODE=bot` listens to allowed customer and group chats. To let the
linked-account owner answer a customer manually, enable
`WHATSAPP_FORWARD_OWNER_MESSAGES=true`; an owner-authored message is stored as
the assistant response and pauses automatic replies in that chat for
`WHATSAPP_HANDOVER_MINUTES`. `WHATSAPP_MODE=self-chat` instead accepts only
messages you type in your own WhatsApp chat and prefixes agent replies so they
are easy to distinguish. Override the prefix with `WHATSAPP_REPLY_PREFIX`
(literal `\\n` sequences become line breaks), or set it to `none` to remove it.

Agent output uses WhatsApp-native formatting and live responses are edited in
place. Existing absolute local paths emitted as `MEDIA:/path/to/file` are sent
natively as images, videos, audio, or documents based on extension. Use
`VOICE:/path/to/audio` for a push-to-talk note; non-Opus audio and GIF animation
are converted to WhatsApp-compatible formats with FFmpeg.
A line such as `LOCATION:38.7223,-9.1393 | Lisbon | Portugal` sends a native map
pin. Read receipts are disabled by default and, when enabled, are sent only
after allowlist/group/mention policy accepts the incoming message.

The socket lifecycle follows the current
[Hermes Agent WhatsApp bridge](https://github.com/NousResearch/hermes-agent/blob/main/scripts/whatsapp-bridge/bridge.js):
it resolves the current WhatsApp Web protocol version with a bounded fallback,
uses Baileys v7's message-retry callback, disables full-history sync and online
presence, serializes outbound sends, applies send timeouts, retries failed
reconnections, and resolves phone-number/LID aliases for allowlists. Hermes runs
this logic as a Node sidecar because its main gateway is Python; this project is
already Node.js, so the same behavior runs directly inside the adapter.

For direct messages delivered by WhatsApp as an `@lid` address, the adapter
uses Baileys' `remoteJidAlt` phone-number address (or its persisted LID mapping)
as the session and reply route. This avoids the Baileys failure mode where an
outbound message sent directly to `@lid` is accepted locally but cannot be
decrypted by the recipient and may close the outgoing pre-key session.

### Session management

Each chat gets its own conversation thread in memory. Sessions auto-purge after `SESSION_RESET_MINUTES` of inactivity (default: 60 min).

## CRM Filtering and Pagination

The CRM tool accepts both an exact `body` payload and a higher-level `filters` object. Use `filters` for end-user search criteria:

- `/api/Property/ListProperties`: filters are merged into the top-level property `FilterRq` body, e.g. `Active`, `VisibleOnWebsite`, `PriceFrom`, `PriceTo`, `MinBedrooms`, `PropertyTypeIds`, `AgentId`, `AgencyId`, `FreeText`.
- `/api/Leads/List`: filters are merged into the top-level lead request, e.g. `StartDate`, `EndDate`, `Category`, `OriginId`, `Language`.
- `/api/Agency/GetAgencies`: filters are merged under `AgencySearchFilters`.
- `/api/Entity/GetAgents`: filters are merged under `EntitySearchFilters`.

Supported paginated list endpoints are auto-paginated by default and return one merged response with `_pagination` metadata:

- `/api/Agency/GetAgencies` via `PagingRq.Current` / `PagingRq.ResultsPerPage`
- `/api/Entity/GetAgents` via `PagingRq.Current` / `PagingRq.ResultsPerPage`
- `/api/Entity/GetOwnerlinks` via `PagingRq.Current` / `PagingRq.ResultsPerPage`
- `/api/Property/ListProperties` via `SequenceNmbr` / `MaxResponses`

`/api/Leads/List` supports filters, but the API spec does not expose pagination
fields for that endpoint. Because an unfiltered response contains the complete
lead history, the tool sorts lead results by `CreateDate` descending and returns
compact summaries of the newest 20 by default. Use `resultLimit` (up to 100),
`resultSortBy`, and `resultSortDirection` to change that bounded result. Set
`resultDetail` to `full` only when complete nested event data is necessary. The
returned `_result` metadata includes the full matching count, detail level, and
whether records were truncated.

## Authentication

### LLM Provider
Each provider needs its own API key env var (see `.env.example`). Aggregators like OpenRouter only need one key to access models from dozens of vendors.

### CRM API
The CRM client supports three auth methods (configure in `.env`):

- **API Key**: `CRM_API_KEY` → sent as `X-API-Key` header
- **Basic Auth**: `CRM_USERNAME` + `CRM_PASSWORD`
- **Bearer Token**: `CRM_BEARER_TOKEN`

The production endpoint defaults to `https://crmapi.casafaricrm.com`. Override
it with `CRM_BASE_URL` when using another CRM environment. Requests time out
after 30 seconds by default; configure `CRM_TIMEOUT_MS` if needed. A Cloudflare
403 means the deployment server's public IP must be allowed by the CRM's
security configuration.

## Property PDF Brochures

The agent includes a `generate_property_pdf` tool. Ask for a property PDF by
reference or CRM property ID, for example:

```bash
npm run dev -- "Generate a PDF brochure for property ABC123"
```

The tool fetches the listing from `/api/Property/ListProperties`, normalizes
title, description, facts, features, agent details, and photos, asks the
configured LLM to write the brochure hook and short intro, then writes a
branded PDF to `output/pdf/property-<reference>.pdf`. If the LLM copy call
fails, the tool falls back to conservative copy from the listing data so PDF
generation still completes.

Optional brand configuration:

```bash
PROPERTY_PDF_BRAND_NAME=Bonte
PROPERTY_PDF_LOGO_PATH=/absolute/path/to/logo.png
PROPERTY_PDF_PRIMARY_COLOR=#173f38
PROPERTY_PDF_ACCENT_COLOR=#c7a76c
```

In the messaging gateway, the agent emits a `MEDIA:/absolute/path.pdf` marker
after generation. The gateway strips that marker from visible text and uploads
the PDF as a native Telegram or WhatsApp document.

## Broker Reminder Sub-Agent

The CRM agent includes a DeepAgents sub-agent named `broker-reminder-agent`.
It is used for broker follow-up and reminder analysis. The sub-agent can inspect
CRM records through `call_crm_api` and draft reminder messages, but it does not
send messages or mutate CRM data.

Example:

```bash
npm run dev -- "Check if any brokers need reminders for leads from the last 7 days and draft the messages"
```

## Available CRM Endpoints

The agent can call any endpoint defined in `api.json`:

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/Agency/GetAgencies` | List agencies |
| POST | `/api/CasafariGo/GetUrl` | Get CasafariGo URL |
| POST | `/api/CasafariGo/CreateUser` | Create CasafariGo user |
| POST | `/api/CasafariGo/DeleteUser` | Delete CasafariGo user |
| GET | `/api/CodeTable` | Get code tables |
| POST | `/api/Entity/GetAgents` | List agents |
| POST | `/api/Entity/GetOwnerlinks` | Get owner links |
| POST | `/api/Leads/Insert` | Insert a lead |
| POST | `/api/Leads/List` | List leads |
| POST | `/api/Property/SendProperty` | Insert/Update property |
| POST | `/api/Property/DeleteProperty` | Delete property |
| POST | `/api/Property/ListProperties` | List properties |
| POST | `/api/Property/Location` | Get locations |
| POST | `/api/Property/InnerLocations` | Get inner locations |
| POST | `/api/Property/Hit` | Record property visit |

## Adding a New Provider

1. Add an entry to `src/providers/registry.ts`:

   ```typescript
   myprovider: {
     name: "myprovider",
     displayName: "My Provider",
     transport: "openai_chat",
     isAggregator: false,
     baseUrl: "https://api.myprovider.com/v1",
     apiKeyEnvVar: "MYPROVIDER_API_KEY",
     baseUrlEnvVar: "MYPROVIDER_BASE_URL",
     defaultModel: "my-model",
   }
   ```

2. Set the env vars:

   ```bash
   LLM_PROVIDER=myprovider
   LLM_MODEL=my-model
   MYPROVIDER_API_KEY=...
   ```

That's it — the factory handles the rest.
