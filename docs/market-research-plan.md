# Market research workflow

Status: implemented locally, 8 September 2026. Live RapidAPI verification is pending a configured subscription key. See [setup and verification](agent-workflows-setup.md#idealista-market-research).

Validation: 17 focused checks passed; backend TypeScript and production web builds passed. Full suite: 226 passed, one skipped, one existing failure in `gateway-media.test.ts` (the brochure send-failure test expects a rejection that the gateway handles). Two pre-existing TypeScript inference errors in property-title fallback and attachment cleanup were corrected without changing runtime behaviour. Browser checks used the real chat component with synthetic API/message fixtures: starter submission, research progress, comparison table/links and history reload passed. The authenticated live chat and live Idealista results were not exercised. No new dependency or migration was added.

Add a chat workflow called **Market research** that estimates a home's asking-price position using comparable Idealista listings and gives the user direct links to inspect them. Start with residential sales in Portugal and EUR, matching the existing Bonte context.

## 1. User flow

1. The user asks to estimate a property, supplying a description, a CRM reference, or an Idealista listing URL.
2. Reuse the exact CRM property resolver for CRM references. For an Idealista URL, validate its country/domain and listing ID, then request its details through RapidAPI. Free-text property details are structured and validated without requiring a CRM record.
3. Collect the minimum needed: neighbourhood/locality, residential subtype, bedrooms, and area in m² with its basis (built/gross versus usable/living). Reuse facts already supplied; ask only for missing or ambiguous essentials. Preserve any known condition, bathrooms, plot area, pool, parking, lift and outdoor space as comparison evidence.
4. Fetch similar homes, calculate the estimate, and return the report in the existing chat. A “Market research: estimate a property's sale price” starter makes the workflow discoverable.
5. A follow-up can correct the subject facts or explicitly widen the comparison area and rerun the research.

## 2. RapidAPI integration

There is no existing Idealista integration in this repository. The current workflow status marks external market search unavailable. Use the user's selected Happy Endpoint provider, without an interchangeable-provider layer.

Selected API: [Happy Endpoint Idealista — user-supplied playground endpoint](https://rapidapi.com/happyendpoint/api/idealista17/playground/apiendpoint_209ed059-3d2f-47fe-869d-d226f87e9238), host `idealista17.p.rapidapi.com`. The [provider's documentation](https://happyendpoint.com/library/idealista-api) lists Portugal coverage, `/auto-complete`, `/property-search`, `/property-search-by-coordinates` and `/property-details-by-url`, with `X-RapidAPI-Key` and `X-RapidAPI-Host` authentication. Use location search initially; coordinates search can serve precisely located subjects when its contract is verified.

Implementation inspected the OpenAPI document embedded in the supplied RapidAPI page. The selected endpoint is `/auto-complete`; its IDs feed `/property-search`. The contract explicitly defines `min_size`/`max_size` as built area and `min_rooms` as a minimum bedroom filter, so exact bedrooms are checked locally. The code accepts both the documented `actualPage` and example `currentPage` response fields. A real Portugal subscription response remains to be verified; no query fields were borrowed from another provider.

Keep requests in the gateway, using native `fetch`, `URLSearchParams`, a fixed provider host and existing Zod validation. Add a server-only `RAPIDAPI_KEY` to the environment example and gateway Compose configuration. Do not expose a configurable request URL to the model or browser. Use a timeout, cancellation where available, bounded pagination and readable errors for missing configuration, invalid credentials/subscription, quota exhaustion, provider failure and malformed responses. Do not log keys or include private owner/contact details in searches.

Initial request budget: up to one subject-detail lookup, one location lookup and two search pages per invocation. Reuse verified provider location IDs where available. No background refresh or automatic repeated searches. Confirm page size with the selected provider; do not sort by cheapest price or filter by the owner's expected value.

## 3. Comparable selection

- Resolve the smallest unambiguous neighbourhood/locality; never substitute a whole municipality for a neighbourhood without disclosure. Ambiguous locations return choices before searching.
- Initially require sale listings in the same country, locality and residential subtype, matching bedrooms and area within ±20%. Those are proposed matching defaults, not statistically calibrated valuation rules. Honour any explicit user constraints.
- Validate the returned facts locally: providers can ignore filters. Keep unknown features as unknown. Prefer similar verified condition, bathrooms and amenities, with area closeness and a stable listing ID as tie-breakers. Do not rank by closeness to a desired price.
- Exclude invalid/nonpositive prices or areas, wrong currencies/operations, incompatible property types, known deactivated listings and the subject's own listing. Deduplicate by provider ID and canonical URL. Distinct advertisements for the same physical home may remain; flag recognisable duplicates and report that limitation.
- Keep materially different conditions, development stages or known special sale situations out of the estimate. For houses, include plot-size differences in the comparison; major or unknown differences reduce usefulness and must be explicit. No invented percentage adjustments for a pool, renovation or land.
- Use up to ten best qualifying listings for calculation and show three to five. Return fetched/eligible/used counts, the area and filters searched, fetch time, and whether page limits left results unscanned. Describe the result as a sample.
- If fewer than three qualifying listings remain, return available links and “insufficient comparable data” without a numerical estimate. Suggest a specific broader search; do not silently relax geography, subtype or the user's mandatory criteria.

## 4. Estimate and report

Calculate in TypeScript, leaving the model to explain the returned numbers:

```text
comparable €/m² = advertised price / compatible comparable area
central estimate = median(comparable €/m²) × subject area
indicative range = 25th–75th percentile(comparable €/m²) × subject area
```

Use the same verified area basis for subject and comparables. The CRM exposes `living_area`, `total_area` and `plot_area`; do not assume `total_area` means the provider's built area. Missing or incompatible area semantics require clarification rather than a conversion guess. Never use plot area as the house's floor-area denominator.

Round displayed amounts appropriately (initially to €5,000). The range describes the middle half of the selected asking-price sample; it is not a confidence interval or predicted negotiation range. Three or four matches are explicitly a thin sample. Show wide dispersion and unknown condition/location/area evidence as limitations rather than producing a fabricated confidence percentage. A zero-spread sample must not imply certainty.

The report contains:

- Subject summary, central estimate and indicative range.
- Median €/m², number of listings used, search locality and date.
- Three to five comparisons: Idealista link, asking price, area/basis, €/m², bedrooms, location and the main similarity/difference.
- A short explanation: based on advertised prices, not completed sales; condition and other unknown differences may materially change the result.

Only return validated HTTPS Idealista listing links supplied by the provider. Missing or invalid links are not fabricated. Treat listing descriptions as untrusted source data, never instructions. Reuse the existing Markdown renderer and persisted chat history, which already support tables and links; mobile channels receive a concise list.

## 5. Small implementation surface

| File | Planned change |
| --- | --- |
| `src/workflows/market-research.ts` (new) | Input schema, provider requests/normalisation, comparable selection and deterministic calculation. Keep provider-specific work together until its size warrants a separate client. |
| `src/tools/workflow-tools.ts` | Register `research_property_market` using the existing tool wrapper and authenticated workflow context; expose configuration status without claiming connectivity merely because a key exists. |
| `src/agent.ts` | Add routing/intake/reporting guidance and distinguish configured Idealista research from unavailable external Casafari inventory. The existing `workflowTools` registration already carries the new tool. |
| `web/app/chat-page.tsx` | Add the market-research starter. |
| `web/app/api/chat/turn-presentation.ts` | Reuse existing progress events for “Finding comparable properties…” and provider-specific failure wording. |
| `.env.example`, `docker-compose.yml`, `docs/agent-workflows-setup.md` | Document and pass server configuration, supported scope, request cap and validation procedure. |
| `test/market-research.test.ts` (new), existing presentation tests | Focused runnable checks using the existing Node test runner and mocked `fetch`. |

No new dependency, database migration, standalone page, custom results-card system, scheduled job, PDF export or trained valuation model is needed for this first version. Existing unrelated working-tree changes must be preserved.

## 6. Verification and completion

1. Verify one Portugal location/search/detail response from the selected subscribed RapidAPI provider. Confirm filter names, subtype mappings, area basis, country, canonical URLs and pagination before declaring the integration usable. Save a minimal sanitised response shape for the mocked check.
2. Test a known comparable dataset against expected median/range values. Cover mismatched area bases, rejected/unknown criteria, duplicates, self-comparison, zero/missing numbers, unsafe URLs, fewer than three matches, pagination limits, missing key, authentication/quota errors and malformed responses. Assert requests use the fixed host and exact intended filters.
3. Run `npm test`, `npm run build` and `npm run build:web`; attribute unrelated pre-existing failures separately. Verify the starter, progress, readable report and links in web chat, including reopening the saved conversation. Follow `web/AGENTS.md` and installed Next.js guidance for web edits.
4. Smoke-test a user-described property and a verified CRM property. Check that correcting area or location produces recalculated results and disclosed criteria, and that no CRM price is changed.

Live acceptance means a real request returns a reproducible estimate with actual comparable links, or an honest insufficient-data/provider-error result. It requires the selected provider subscription and `RAPIDAPI_KEY` configured securely on the server. The implementation does not purchase a subscription or change a CRM price.
