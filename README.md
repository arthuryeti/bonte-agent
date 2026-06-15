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

## Subscription-Provider Pattern

Instead of calling OpenAI or Anthropic directly, the agent routes through a **provider abstraction**:

| Type | Providers | What you get |
|------|-----------|--------------|
| **Aggregators** | `openrouter`, `together`, `nous`, `huggingface` | One API key → 200+ models. Switch models by changing `LLM_MODEL`. |
| **Direct** | `openai`, `anthropic`, `deepseek`, `groq`, `ollama`, `zai`, `kimi` | Talk straight to the vendor's API. |

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

# Kimi (Moonshot AI)
LLM_PROVIDER=kimi
LLM_MODEL=kimi-k2-latest
KIMI_API_KEY=...
```

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

# WhatsApp — enables Baileys WebSocket connection
WHATSAPP_ENABLED=true
WHATSAPP_AUTH_DIR=.whatsapp-auth            # session persistence
WHATSAPP_ALLOW_FROM=                        # optional JID allowlist
WHATSAPP_REQUIRE_MENTION=true               # optional (groups only)
```

**WhatsApp first-time setup:** On first run, Baileys prints a **QR code** to the terminal. Scan it with WhatsApp on your phone (Linked Devices → Link a Device). Credentials are saved to `WHATSAPP_AUTH_DIR` so you don't need to scan again.

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

`/api/Leads/List` supports filters, but the API spec does not expose pagination fields for that endpoint.

## Authentication

### LLM Provider
Each provider needs its own API key env var (see `.env.example`). Aggregators like OpenRouter only need one key to access models from dozens of vendors.

### CRM API
The CRM client supports three auth methods (configure in `.env`):

- **API Key**: `CRM_API_KEY` → sent as `X-API-Key` header
- **Basic Auth**: `CRM_USERNAME` + `CRM_PASSWORD`
- **Bearer Token**: `CRM_BEARER_TOKEN`

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
