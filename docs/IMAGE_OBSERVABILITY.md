# Image model routing, observability, usage, and cost

## Azure deployment and model semantics

`IMAGE_DEPLOYMENT` (or `--deployment`) selects the default Azure deployment. If discovery is enabled, a request may select either an exact discovered deployment or an unambiguous model-family alias. Static Azure mode (no discovery endpoint) advertises and routes only `IMAGE_DEPLOYMENT`; the capability registry remains separate and does not imply deployability. Discovery mode may route exact discovered deployments or unambiguous model-family aliases. Set `IMAGE_STRICT_DEPLOYMENT_PINNING=true` to pin discovery mode to the configured deployment too.

JSON results distinguish `configured_deployment`, `requested_model`, `resolved_deployment`, and `effective_model`. No fallback is implicit.

## MAI capability registry

The registry in `src/providers/model-capabilities.ts` is consumed by routing and validation. MAI-Image-2.5 generation/editing constraints are confirmed. MAI-Image-2.5-Flash generation through `/mai/v1` is enabled when Foundry discovery identifies Microsoft as publisher; editing, variation, and quality remain unknown and therefore disabled. Flash uses the conservative confirmed MAI pixel-budget and PNG output contract until authoritative evidence proves otherwise.

## Deterministic workspace paths

For `image_generate` and `image_edit`, pass `workspace_output_path` with `save_to_workspace=true` to choose a relative path below `<workspace>/generated` in the first accepted MCP root. Example: `design/target.png`, never `generated/design/target.png`. Leading `generated/`, absolute paths, traversal, empty/dot components, backslashes, platform-unsafe names, existing files, and symlinked path components are rejected, not silently normalized. The extension must match `output_format` (default `png`); a differing provider output format is also rejected. For requested `n>1`, `-1`, `-2`, and so on are inserted before the extension, even if fewer outputs are returned; indexes stay aligned.

Explicit paths require a server connection and accepted roots. All `n` destinations are preflighted before the provider call; failures never fall back to another root or only automatic storage. HTTP/multi-user transports fail closed unless `IMAGE_WORKSPACE_ALLOWED_ROOTS` explicitly permits the root; trusted stdio mode may operate without an allowlist. Destinations are pinned and rechecked after the provider call. Writes use a same-directory 0600 temporary file, sync it, and atomically publish with an exclusive hard link, so readers never observe partial output and an existing destination is never overwritten. Temporary files are cleaned on failure. Late collisions can occur after billing and return an error; multi-output publication is not a batch transaction. Preflight may create safe parent directories. Without an explicit path, automatic persistence and best-effort random workspace copies are unchanged.

## Prompt and stage provenance

JSON responses include a request ID, input/effective SHA-256 prompt hashes, enhancement state, model provenance, and milliseconds for validation, elicitation, enhancement, provider, storage, workspace copy, and total. Set request field `disable_prompt_enhancement=true` for comparable benchmarks. Stage histograms are exported by Prometheus. Model labels use only bounded canonical families (`gpt-image-*`, `mai-image-*`, `dall-e-2`, `other`, or `unknown`); requested and deployment names are never labels.

## Usage and public-price estimates

Provider usage is normalized without synthesizing missing counters: `input_tokens`, `output_tokens`, `image_tokens`, `total_tokens`, and `billable_units` are numbers or null, with `usage_source`. MCP metadata is informational; it is not automatic Goose billing/accounting.

| Model | Azure response mapping | Public pricing state |
|---|---|---|
| MAI-Image-2.5 | Copy only numeric fields actually present in the response `usage` object; absent fields are null | Unavailable by default; configure an authoritative source explicitly |
| MAI-Image-2.5-Flash | Same conservative mapping; no counter is inferred from image count or dimensions | Unavailable by default; configure an authoritative source explicitly |
| gpt-image-2 | Same normalized mapping from the SDK response `usage` object | Unavailable by default; configure an authoritative source explicitly |

Authoritative pricing inputs must cite an official Azure pricing page or Azure Retail Prices API URL and record region, deployment tier, currency, unit category, retrieval date, effective date when published, and local table version. This project intentionally ships no numerical price because no verified public model/region/tier price evidence is bundled. Retrieved metadata is descriptive and does not represent an Azure invoice.

Cost is always named `estimated_cost`, never billed or actual cost. No built-in prices are asserted. To opt in, set `IMAGE_PUBLIC_PRICING_JSON` to a JSON array whose entries contain `model`, `region`, `deployment_tier` (`global`, `data-zone`, `regional`, or `fallback`), ISO-4217-style uppercase `currency`, `token_category`, `pricing_unit` (currently only `per_million_units`), finite non-negative `price_per_million_units`, HTTPS `source_url`, ISO `retrieved_at`, optional ISO `effective_at`, `version`, and optional `source_kind` (`authoritative` or `fallback`). Use only an authoritative public Azure source. Missing usage or price produces an explicit unavailable result, never zero.


Prices older than `IMAGE_PRICING_MAX_AGE_DAYS` (default 90) or future-dated are unavailable. Optional `IMAGE_PRICING_REGION` and `IMAGE_PRICING_DEPLOYMENT_TIER` constrain selection. Matching authoritative entries win over fallback entries, then the newest retrieval date wins. Distinct per-response counters are summed across multiple images while a shared request-level usage object is counted once; cost is calculated once from the aggregate and rounded half-up to eight decimal places. Invalid tables, unknown shapes, stale prices, missing counters, and non-finite calculations are unavailable, never zero.
