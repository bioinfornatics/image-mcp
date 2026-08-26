# Changelog

All notable changes to `@bioinfornatics/image-mcp` are documented here.  
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).  
Versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.3.3] — 2026-08-26

### Added
- Return ready-to-use absolute-path Markdown for generated, edited, and variation images saved to an MCP workspace.
- Instruct MCP clients such as Goose to preserve that Markdown unchanged so local images render directly in the conversation.
- Expose the same rendering snippet as `display_markdown` in JSON responses.

## [0.3.2] — 2026-08-26

### Fixed
- Invalidate the remote BuildKit cache for Alpine security upgrades so CI scans the current OpenSSL 3.5.8 packages instead of a cached vulnerable layer.

## [0.3.1] — 2026-08-26

### Security
- Refresh Alpine packages in both Docker build and runtime stages so copied dependencies do not retain OpenSSL packages affected by CVE-2026-14456.

### Fixed
- Use Bun directly for TypeScript build and type-check scripts so package hooks remain anchored to the repository under wrapped Node environments.

## [0.3.0] — 2026-08-26

### Added
- Route discovered Microsoft MAI-Image-2.5-Flash deployments through the MAI generation API with conservative, registry-backed capabilities.
- Return explicit configured, requested, resolved, and effective model provenance, plus input/effective prompt hashes and prompt-enhancement state.
- Report per-stage and total timings for validation, elicitation, enhancement, provider calls, storage, and workspace copies.
- Normalize provider usage counters and support opt-in public-price `estimated_cost` metadata with authoritative-source provenance and explicit unavailable states.
- Document routing, provenance, output-path behavior, timings, usage normalization, and cost estimation in `docs/IMAGE_OBSERVABILITY.md`.

### Changed
- Support deterministic relative workspace output paths below accepted MCP roots, including collision-safe names for multiple generated images.
- Expose bounded model-family labels and stage latency histograms for operational observability without leaking requested model or deployment names.

### Security
- Harden workspace writes against absolute paths, traversal, symlink escapes, partial writes, overwrites, and unapproved roots in HTTP or multi-user transports.
- Fail closed for unknown capabilities, invalid or stale pricing data, missing usage counters, and non-finite cost calculations; never present estimates as billed or actual cost.

## [0.2.1] — 2026-08-21

### Fixed
- Advertise the installed package version during MCP initialization instead of the stale `0.1.0` protocol version.
- Preserve Windows drive paths in MCP Roots and compare canonical runner paths reliably.
- Harden workspace writes against symlink and junction escapes.

### Changed
- Pin CI actions by immutable commit and gate npmjs publication until package-scope authorization is enabled.
- Refresh the documented test count to 811 passing tests.

## [0.2.0] — 2026-08-20

### Added
- First-class OpenRouter Image API support for Nano Banana 2 and Microsoft MAI-Image-2.5.
- Dynamic Foundry/OpenRouter model discovery, structured provider errors, and controlled model fallback.
- Primary `image-mcp` executable with temporary `gpt-image-mcp` compatibility alias.

### Changed
- Project and npm package renamed from `gpt-image-mcp` to `image-mcp` / `@bioinfornatics/image-mcp`.
- MCP server, health identity, metrics, Docker resources, output directory, documentation, and examples use the provider-neutral name.

### Migration
- Replace `@bioinfornatics/gpt-image-mcp` with `@bioinfornatics/image-mcp`.
- Existing `IMAGE_*` variables remain unchanged.
- The legacy executable, HTTP health identity, and keytar service lookup remain temporarily supported.

## [0.1.7] — 2026-08-19

### Added
- Strict Azure-provider inference for canonical `https://<resource>.services.ai.azure.com` base URLs.

### Security
- Reject deceptive hosts, non-HTTPS URLs, credentials, ports, query strings and non-root paths during inference.

### Notes
- The hostname identifies the Foundry resource/account, not the Azure resource group or project. Project endpoints remain explicit because they cannot be derived reliably from the resource URL.

## [0.1.6] — 2026-08-19

### Added
- Safe non-secret CLI flags `--base-url` and `--foundry-project-endpoint`.

### Changed
- Goose examples favor CLI arguments for non-secret runtime configuration and reserve `env_keys` for secrets.
- Azure examples no longer duplicate the deployment with `IMAGE_DEFAULT_MODEL` or force a global API version/log level.

## [0.1.5] — 2026-08-19

### Added
- Safe CLI configuration overrides, help/version commands, redacted configuration checks, and source provenance.
- CWD-independent quality gate and prepack build verification.
- Byte-level PNG/JPEG/WebP validation with detected media types propagated through providers, storage, and MCP responses.
- Arbitrary gpt-image-2 dimensions, experimental-resolution warnings, and up to 16 source images for editing.
- Dedicated MAI-Image-2.5 adapter and Azure multi-deployment routing: IMAGE_DEPLOYMENT selects the default, while explicit MAI-Image-2.5 and gpt-image-2 requests use their respective APIs.
- Authenticated Azure deployment catalog with cache, pagination-loop detection, page limits, and cross-origin nextLink rejection.
- Model-aware elicitation, validation, provider listing, and actionable content-safety guidance.

### Changed
- Custom providers negotiate inline base64 responses without unsafe URL fallback.
- Image outputs are stored and returned according to verified bytes rather than the requested format.
- Goose documentation now explains secret-store resolution and absolute bin/start.sh usage for local clones.

### Security
- Raw CLI secrets remain rejected; use the _FILE variants.
- Azure catalog credentials are never forwarded to cross-origin pagination URLs.
- Live Foundry tests require explicit RUN_LIVE_TESTS=true plus an ignored local API_KEY file.

### Migration notes
- Ensure MAI-Image-2.5 and gpt-image-2 deployments exist in the configured Foundry resource when both are required. IMAGE_DEPLOYMENT is the default; the MCP model argument selects another confirmed adapter.
- Malformed or mislabeled image bytes now fail before provider I/O.
- Configuration precedence is CLI, canonical IMAGE_* environment variable, legacy alias, then built-in default.

## [0.1.2] — 2026-08-10

### Fixed
- Do not require HTTP bearer authentication in local `stdio` transport; HTTP remains authenticated by default.
- Add an npx-first Goose HOWTO and correct end-user OpenAI/Azure examples.

## [0.1.1] — 2026-08-10

### Added
- Persist generated images automatically in the platform Pictures directory and return native MCP image content with file resource links.
- Resolve freedesktop base directories from `XDG_*` variables with specification defaults (`~/.local/share`, `~/.config`, `~/.cache`, `~/.local/state`).
- Support `IMAGE_OUTPUT_DIR` as an explicit output-location override.

### Fixed
- Remove the blocking `xdg-user-dir` subprocess from image generation, making CI and headless Linux execution deterministic.
- Update vulnerable HTTP dependencies and lock transitive security fixes; `bun audit --audit-level=high` is clean.

### Deprecated

The following environment variable names were renamed in **v0.1.0** and will be **removed in v0.3.0**.
The server still accepts them and emits a `DEPRECATED` warning to stderr on startup.
Migrate before upgrading to v0.3.0.

| Old name (deprecated) | New name | Notes |
|---|---|---|
| `PROVIDER` | `IMAGE_PROVIDER` | |
| `OPENAI_API_KEY` | `IMAGE_API_KEY` | All providers share one key var |
| `AZURE_OPENAI_API_KEY` | `IMAGE_API_KEY` | ↑ |
| `TOGETHER_API_KEY` | `IMAGE_API_KEY` | ↑ |
| `CUSTOM_OPENAI_API_KEY` | `IMAGE_API_KEY` | ↑ |
| `OPENAI_BASE_URL` | `IMAGE_BASE_URL` | All providers share one URL var |
| `AZURE_OPENAI_ENDPOINT` | `IMAGE_BASE_URL` | ↑ |
| `CUSTOM_OPENAI_BASE_URL` | `IMAGE_BASE_URL` | ↑ |
| `AZURE_OPENAI_DEPLOYMENT` | `IMAGE_DEPLOYMENT` | |
| `AZURE_OPENAI_API_VERSION` | `IMAGE_API_VERSION` | |
| `CUSTOM_OPENAI_MODELS` | `IMAGE_MODELS` | |
| `DEFAULT_MODEL` | `IMAGE_DEFAULT_MODEL` | |

---

## [0.1.0] — 2026-05-03

> **Major feature release.** Full `gpt-image-2` support, multi-image compositing,
> context-aware prompt enhancement, hardened security, and 481 passing tests (+164 since 0.0.2).

### Added

#### `image_generate` tool
- **`gpt-image-2` arbitrary resolution**: size now accepts any `WxH` string validated against all four API constraints (multiples of 16, max edge < 3840, ratio ≤ 3:1, pixels 655 360–8 294 400). Fixed-size presets still work unchanged.
- **`isExperimentalResolution()`**: sizes above 2 560 × 1 440 are flagged as experimental in tool output per the OpenAI guide.
- **`skip_elicitation` parameter**: set `true` to bypass the interactive quality/size form — recommended for automated pipelines.
- **`resolveModeration()` helper**: `moderation: "low"` is silently downgraded to `"auto"` unless `IMAGE_ALLOW_LOW_MODERATION=true` is set in the environment.

#### `image_edit` tool
- **Multi-image compositing**: new `images: string[]` parameter (1–5 base64 images) for virtual try-on, person-in-scene insertion, and general compositing. `image` (single) and `images` (array) are mutually exclusive and validated at the schema layer.
- **`input_fidelity` parameter** (`"low" | "high"`): identity-preservation control for `gpt-image-1.x` models. Automatically suppressed (not forwarded) when `model: "gpt-image-2"` to prevent API 400.
- **10 MB aggregate payload guard**: tool rejects `images[]` requests whose total decoded size exceeds 10 MB before touching the network.

#### Elicitation service
- **Redesigned form UX**: `size` shown first (more visually intuitive than quality), conversational `message` string, human-readable descriptions that name use-cases rather than raw API values.
- **Size options aligned with schema**: elicitation no longer offers sizes the Zod schema would reject.

#### Sampling service
- **Context-aware prompt enhancement**: `enhancePrompt()` now accepts a full `ImagePromptContext` (model, quality, size, output_format, background, n) resolved after elicitation, enabling context-specific prompt construction.
- **Adaptive token budget**: 80 tokens for `quality: "low"` (fast draft loop), up to 350 for `quality: "high"` + large canvas.
- **Photorealism system prompt**: structured photography vocabulary, composition cues, and explicit anti-pattern list.
- **Conditional branches**: transparent background, widescreen, portrait, ultra-wide, JPEG, and multi-variant cases each receive tailored guidance.
- **Static helpers** `resolveMaxTokens()` and `buildUserMessage()` are exported and independently unit-tested.

#### Security
- **`IMAGE_REQUIRE_MCP_AUTH`** env var (default `true`): `IMAGE_MCP_API_KEY` is now required by default. Set `IMAGE_REQUIRE_MCP_AUTH=false` to allow unauthenticated access for local development.
- **`detectForgeryIntent()`** in `sanitise.ts`: heuristic detection of prompts describing screenshot forgery, domain impersonation, or fabrication of official-looking documents.
- **Byte-aware rate limiting**: `RateLimitGuard` now tracks cumulative payload bytes per client window in addition to request count. Configurable via `IMAGE_MAX_BYTES_PER_MINUTE` (default 50 MB). Separate 429 error messages distinguish count-limit from byte-limit violations.

#### Provider interface
- `EditParams.image` changed to optional (required when `images[]` not provided).
- `EditParams.images?: string[]` added for multi-image compositing.
- `EditParams.input_fidelity?: 'low' | 'high'` added.

### Fixed

#### Schema bugs (all caused API 400 on `gpt-image-*` models)
- Removed `"hd"` and `"standard"` from `ImageGenerateSchema.quality` — DALL-E 3 tokens, retired 2026-03-04.
- Removed `"256x256"`, `"512x512"`, `"1792x1024"`, `"1024x1792"` from `ImageGenerateSchema.size` — DALL-E 2/3 sizes invalid for `gpt-image-*`.
- Removed `"standard"` from `ImageEditSchema.quality`.
- Removed `"256x256"`, `"512x512"` from `ImageEditSchema.size`.
- Elicitation size options (`SIZE_OPTIONS_GPT_IMAGE_2`) offered `"2048x2048"` and `"4096x4096"` which the schema rejected — now aligned to `['auto', '1024x1024', '1536x1024', '1024x1536']`.

#### MCP feature routing (all three features were silently no-ops)
- `ElicitationService`, `SamplingService`, and `RootsService` received `McpServer` (the outer wrapper) when they required `Server` (the inner SDK object). `McpServer` does not expose `elicitInput()`, `createMessage()`, or `listRoots()` — calls threw `TypeError` which was silently caught, degrading all M4 features to no-ops on every request.
- Fix: tools now close over `server.server` (the inner `Server`) and pass it to all feature services. `McpServerService.innerServer` getter added.
- Removed all `(server as any)` casts from feature services — methods are now correctly typed.

#### Elicitation flow issues
- Removed dead `hasStyle` parameter (interface accepted it, service never used it).
- Fixed ordering: elicitation now runs **before** sampling so quality/size context is available when the LLM enhances the prompt.

### Changed

- Default model updated to `gpt-image-2` throughout (schemas, tool descriptions, elicitation form, documentation).
- `ImageGenerateSchema.size` changed from `z.enum([...])` to `z.string().superRefine(...)` to support arbitrary `WxH` values for `gpt-image-2`. All existing preset values continue to work.
- `SamplingService.enhancePrompt()` signature changed from `(server, prompt, model: string)` to `(server, prompt, context: ImagePromptContext)`. Breaking for direct callers; tool layer updated.
- Elicitation field order: `size` shown before `quality`.

### Removed

- `PROMPT_MAX_LENGTH_DALLE3` constant (4 000 chars) — DALL-E 3 retired 2026-03-04.
- `hasStyle` parameter from `ElicitationService.requestImageParams()`.
- `"hd"`, `"standard"` from quality enums; DALL-E 2/3 sizes from generate/edit enums.

### Documentation

- `docs/API.md`: updated all model tables, size/quality reference tables, and appendix feature matrix to reflect `gpt-image-2` as primary model and DALL-E 3 retirement.
- `docs/README.md`, `docs/SPECIFICATION.md`, `docs/ARCHITECTURE.md`, `docs/MILESTONES.md`, `docs/TDD_STRATEGY.md`: DALL-E 3 references replaced with retirement notices or removed.
- `examples/goose-config.yaml`: corrected to use `bunx`, scoped package name `@bioinfornatics/image-mcp`, proper `envs:`/`env_keys:` schema, Azure as primary example.
- `README.md`: all install commands updated to scoped package name; Goose config section expanded with OpenAI and Azure variants.

### Tests

- **481 passing tests** (up from 317 at 0.0.2, +164 new).
- New test files: `test/unit/mcp/tools/schemas.spec.ts`.
- Extended: all feature service specs, all tool specs, provider edit/variation spec, rate-limit guard spec, MCP server spec.
- Coverage maintained ≥ 90% lines and functions.

---

## [0.0.2] — 2026-04-29

> **First published release.** Package available on GitHub Packages (`npm.pkg.github.com`) and npmjs.com. Docker image on `ghcr.io`.

### Added
- Initial MCP server with 5 tools: `image_generate`, `image_edit`, `image_variation`, `provider_list`, `provider_validate`.
- OpenAI and Azure OpenAI providers via `@openai/openai` SDK.
- HTTP (Streamable HTTP, stateless per-request) and stdio transports.
- MCP Elicitation, Sampling, and Roots (M4 features).
- Bearer token authentication (`IMAGE_MCP_API_KEY`), rate limiting, prompt sanitisation.
- Multi-platform Docker image (`linux/amd64`, `linux/arm64`).
- CI/CD pipeline: quality gate → Trivy CVE scan → GitHub Packages → npmjs.com → GitHub Release.
- Renovate dependency automation.

### Fixed
- `package.json` `files[]` tightened from `"dist/**/*"` to `"dist/**/*.js"` + `"dist/**/*.d.ts"` + `"bin/start.sh"` — removes `.tsbuildinfo` and `.map` files, tarball 710 KB → 177 KB.
- CI `publish-gpr` switched from `bun publish` to `npm publish + ~/.npmrc` — `bun publish` ignored `BUN_AUTH_TOKEN` when `publishConfig.registry` was set.

---

## [0.0.1] — 2026-04-23

> **Initial tag.** Development baseline; not published to any registry.

### Added
- Project scaffold: NestJS 10, Bun ≥ 1.1, TypeScript strict, MCP SDK v1.29.
- Core architecture: providers, tools, security, health, metrics modules.
- Secret resolution: `_FILE` env vars, keytar OS keychain, plain env (`IMAGE_MCP_SECRET_BACKEND`).
- GitHub Actions CI skeleton.

---

[Unreleased]: https://github.com/bioinfornatics/image-mcp/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/bioinfornatics/image-mcp/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/bioinfornatics/image-mcp/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/bioinfornatics/image-mcp/compare/v0.1.7...v0.2.0
[0.1.7]: https://github.com/bioinfornatics/image-mcp/compare/v0.1.6...v0.1.7
[0.1.6]: https://github.com/bioinfornatics/image-mcp/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/bioinfornatics/image-mcp/compare/v0.1.2...v0.1.5
[0.1.2]: https://github.com/bioinfornatics/image-mcp/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/bioinfornatics/image-mcp/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/bioinfornatics/image-mcp/compare/v0.0.2...v0.1.0
[0.0.2]: https://github.com/bioinfornatics/image-mcp/compare/v0.0.1...v0.0.2
[0.0.1]: https://github.com/bioinfornatics/image-mcp/releases/tag/v0.0.1
