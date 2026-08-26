# image-mcp

> Formerly **gpt-image-mcp**. The npm package is now `@bioinfornatics/image-mcp`; the legacy `gpt-image-mcp` executable remains as a temporary alias. Existing `IMAGE_*` environment variables are unchanged.

> **MCP server** for AI image generation via **OpenAI** and **Azure OpenAI** gpt-image-* models.  
> Built with **Bun + NestJS** · **Streamable HTTP + stdio** transports · **811 tests, 92 % coverage**

---

## Features

| Capability | Detail |
|-----------|--------|
| 🖼️ **image_generate** | Text → image with all gpt-image-* models |
| ✏️ **image_edit** | Inpainting with optional mask (up to 16 input images) |
| 🔀 **image_variation** | dall-e-2 variations (dall-e-2 only) |
| 🔍 **provider_list / validate** | Connectivity check without generating an image |
| ⚡ **MCP Elicitation** | Interactive parameter refinement (quality, size) |
| 🧠 **MCP Sampling** | Prompt enhancement via client LLM |
| 💾 **MCP Roots** | Save images directly to your workspace |
| 🔒 **Security** | Bearer-token auth, rate limiting, secret masking, path traversal prevention |
| 📊 **Observability** | Prometheus `/metrics`, `/health/live`, `/health/ready` |

---

## Quick Start

### Prerequisites

- [Bun](https://bun.sh) ≥ 1.1 **or** Node.js ≥ 20 **or** Docker
- An OpenAI API key **or** Azure OpenAI resource

---

### Option A — Zero-install with `bunx` (recommended)

```bash
# stdio transport (Claude Desktop, Goose, Cursor)
IMAGE_PROVIDER=openai IMAGE_API_KEY=sk-... IMAGE_MCP_TRANSPORT=stdio bunx @bioinfornatics/image-mcp

# HTTP transport on port 3000 (network-facing: MCP bearer token required)
IMAGE_PROVIDER=openai IMAGE_API_KEY=sk-... IMAGE_MCP_TRANSPORT=http IMAGE_PORT=3000 \
  IMAGE_MCP_API_KEY=replace-with-at-least-16-characters \
  bunx @bioinfornatics/image-mcp

# Microsoft Foundry (local stdio; provider inferred from the canonical base URL)
IMAGE_API_KEY=... bunx @bioinfornatics/image-mcp \
  --base-url https://YOUR-RESOURCE.services.ai.azure.com \
  --foundry-project-endpoint https://YOUR-RESOURCE.services.ai.azure.com/api/projects/YOUR-PROJECT \
  --deployment MAI-Image-2.5 \
  --transport stdio
```

**With `npx` (Node.js users):**

```bash
IMAGE_PROVIDER=openai IMAGE_API_KEY=sk-... IMAGE_MCP_TRANSPORT=stdio npx @bioinfornatics/image-mcp
```

### Repeated launches and port reuse

- **Goose and other local MCP hosts should use `stdio`.** Each host launch gets its own pipe-backed process and never binds the shared HTTP port. The packaged command should set `IMAGE_MCP_TRANSPORT=stdio`; the local `bin/start.sh` also defaults to `stdio` when it is omitted.
- **HTTP is a persistent, multi-client server.** Start it once and configure Goose with a `streamable_http` URI. If the HTTP command is run again with the same host and port, it probes `/health/live`: a compatible `image-mcp` listener is reused and the duplicate process exits successfully. An unrelated listener still produces a port conflict rather than being mistaken for this server.

---

### Option B — Install globally

```bash
bun add -g @bioinfornatics/image-mcp
IMAGE_API_KEY=sk-... image-mcp --provider openai --transport stdio
```

---

### Option C — Clone & run from source

```bash
git clone https://github.com/bioinfornatics/image-mcp
cd image-mcp
bun install
cp .env.example .env   # then edit with your keys

bun run start:http     # HTTP on :3000
bun run start:stdio    # stdio
```

---

### Option D — Docker

```bash
docker build -t image-mcp .

docker run -p 3000:3000 \
  -e IMAGE_PROVIDER=openai \
  -e IMAGE_API_KEY=sk-... \
  -e IMAGE_MCP_TRANSPORT=http \
  -e IMAGE_MCP_API_KEY=replace-with-at-least-16-characters \
  image-mcp
```

---

## Configuration

Azure users can choose among **API key**, **Azure CLI**, and **Microsoft Entra OBO**. Start with the [authentication decision guide](docs/authentication/README.md).

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `IMAGE_PROVIDER` | ✅ | — | `openai`, `azure`, `together`, or `custom` |
| `IMAGE_API_KEY` | Conditional | — | API key for OpenAI/Together and Azure `api_key` mode |
| `IMAGE_AZURE_AUTH_MODE` | Azure only | inferred from existing key | `api_key`, `azure_cli`, or `on_behalf_of` |
| `IMAGE_AZURE_TENANT_ID` | ❌ | active CLI tenant | Optional tenant for `azure_cli` |
| `IMAGE_MCP_AUTH_MODE` | ❌ | transport-sensitive | `none`, `static_bearer`, or `entra`; OBO requires `entra` |
| `IMAGE_ENTRA_TENANT_ID` | OBO | — | Trusted Entra tenant |
| `IMAGE_ENTRA_CLIENT_ID` | OBO | — | MCP server app registration ID |
| `IMAGE_ENTRA_AUDIENCE` | OBO | — | Exact MCP API token audience |
| `IMAGE_ENTRA_SCOPE` | OBO | `mcp.access` | Required delegated scope |
| `IMAGE_ENTRA_ALLOWED_CLIENT_IDS` | ❌ | all | Comma-separated allowed OAuth clients |
| `IMAGE_ENTRA_CLIENT_SECRET` | Current OBO baseline | — | Confidential credential; use a secure secret source |
| `IMAGE_BASE_URL` | ✅ if `azure`/`custom` | `https://api.openai.com/v1` | Provider endpoint (Azure resource URL or custom OpenAI-compatible URL) |
| `IMAGE_DEPLOYMENT` | ✅ if `azure` | — | Azure deployment name |
| `IMAGE_API_VERSION` | ❌ | `2025-04-01-preview` | Azure API version |
| `IMAGE_MODELS` | ❌ | `custom` | Comma-separated model list (custom provider only) |
| `IMAGE_DEFAULT_MODEL` | ❌ | `gpt-image-2` | Default model (override per-request via tool param) |
| `IMAGE_MCP_TRANSPORT` | ❌ | `http` | `http` or `stdio` |
| `IMAGE_HTTP_HOST` | ❌ | `127.0.0.1` | HTTP bind address |
| `IMAGE_PORT` | ❌ | `3000` | HTTP listen port |
| `IMAGE_HTTP_ALLOWED_HOSTS` | ❌ | localhost addresses | Comma-separated hostnames accepted by MCP Fastify DNS-rebinding protection |
| `IMAGE_HTTP_ALLOWED_ORIGINS` | ❌ | localhost addresses | Comma-separated browser origin hostnames |
| `IMAGE_MCP_API_KEY` | ❌ | — | Bearer token to protect `/mcp` |
| `IMAGE_USE_ELICITATION` | ❌ | `true` | Enable MCP Elicitation |
| `IMAGE_USE_SAMPLING` | ❌ | `true` | Enable MCP Sampling |
| `IMAGE_MAX_REQUESTS_PER_MINUTE` | ❌ | `60` | Rate limit per client |
| `IMAGE_OUTPUT_DIR` | ❌ | OS Pictures directory | Override the directory where every generated image is persisted |
| `IMAGE_LOG_LEVEL` | ❌ | `info` | `debug`/`info`/`warn`/`error` |

Every generated, edited, or variation image is returned as native MCP image content and persisted automatically. The default directory is the freedesktop `XDG_PICTURES_DIR/image-mcp` on Linux (falling back to `~/Images/image-mcp`), `~/Pictures/image-mcp` on macOS, and `%USERPROFILE%\\Pictures\\image-mcp` on Windows. `save_to_workspace: true` additionally creates a copy in the MCP workspace.

Response paths are explicit: `saved_to` is the absolute automatically persisted file, `file_uri` is the canonical `file:` URI for that same file, and `workspace_copy` is present only when `save_to_workspace: true` successfully creates an additional copy under an MCP Root. `IMAGE_WORKSPACE_ALLOWED_ROOTS` uses `:` between POSIX roots and `;` between Windows roots. Only local file roots are supported; UNC/network authorities such as `file://server/share` are rejected.

---

## MCP Client Setup

Prefer CLI arguments for non-secret runtime settings (`--base-url`, `--foundry-project-endpoint`,
`--deployment`, `--transport`). A canonical `https://<resource>.services.ai.azure.com` base URL
infers `--provider azure` when no provider is explicitly configured. The hostname contains the
Foundry resource/account name—not the Azure resource-group or project name—so the project endpoint
cannot be derived and remains explicit. Keep only secrets in `env_keys` or `*_FILE` variables. For Azure, `--deployment` already defines the runtime default; do not duplicate
it with `IMAGE_DEFAULT_MODEL`. API versions are adapter-owned unless a legacy endpoint explicitly
requires an override. `IMAGE_LOG_LEVEL` defaults to `info` and may be omitted.

### Claude Desktop

`~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) — `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "image-mcp": {
      "command": "bunx",
      "args": ["@bioinfornatics/image-mcp"],
      "env": {
        "IMAGE_PROVIDER": "openai",
        "IMAGE_API_KEY": "sk-...",
        "IMAGE_MCP_TRANSPORT": "stdio",
        "IMAGE_LOG_LEVEL": "error"
      }
    }
  }
}
```

### Goose

For a copy-paste `npx` setup on Linux, macOS, or Windows, including secrets, Azure, first-run verification, output paths, and troubleshooting, see **[Use image-mcp with Goose](docs/HOWTO_GOOSE.md)**.

Add to `~/.config/goose/config.yaml` under `extensions:`:

**OpenAI:**
```yaml
extensions:
  imagemcp:
    enabled: true
    type: stdio
    name: Image MCP
    description: AI image generation via OpenAI
    cmd: npx
    args:
      - "--yes"
      - "@bioinfornatics/image-mcp@0.2.0"
      - --provider
      - openai
      - --transport
      - stdio
    env_keys:
      - IMAGE_API_KEY        # set via `goose configure`; a plain shell `export` alone does not populate Goose's keyring/env_keys
    timeout: 300
```

**Azure AI Foundry:**
```yaml
extensions:
  imagemcp:
    enabled: true
    type: stdio
    name: Image MCP
    description: AI image generation — gpt-image-2 via Azure AI Foundry
    cmd: npx
    args:
      - "--yes"
      - "@bioinfornatics/image-mcp@0.2.0"
      - --provider
      - azure
      - --base-url
      - https://my-resource.services.ai.azure.com
      - --foundry-project-endpoint
      - https://my-resource.services.ai.azure.com/api/projects/my-project
      - --deployment
      - MAI-Image-2.5
      - --transport
      - stdio
    env_keys:
      - IMAGE_API_KEY
    timeout: 300
```

> See [`examples/goose-config.yaml`](examples/goose-config.yaml) for all options including HTTP transport and local development.

### HTTP / Remote Client

```
POST http://localhost:3000/mcp
Accept: application/json, text/event-stream
Content-Type: application/json
Authorization: Bearer <IMAGE_MCP_API_KEY>   # only if IMAGE_MCP_API_KEY is set

{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"image_generate","arguments":{"prompt":"a cat"}}}
```

---

## Image routing and observability

Azure supports discovered MAI-Image-2.5 and MAI-Image-2.5-Flash deployments. The configured deployment is the default; discovered exact deployment names or unambiguous model families may override it unless `IMAGE_STRICT_DEPLOYMENT_PINNING=true`.

Generation JSON includes model and prompt provenance, stage timings, normalized provider usage, and an optional public-price `estimated_cost`. No prices are built in and estimates are never billed cost. Safe deterministic workspace targets are available through `workspace_output_path`; prompt enhancement can be disabled with `disable_prompt_enhancement`.

See [Image model routing, observability, usage, and cost](docs/IMAGE_OBSERVABILITY.md) for contracts and configuration.

## Available Models

> **As of April 23, 2026** — model landscape has changed significantly. dall-e-3 was retired.

### OpenAI (`IMAGE_PROVIDER=openai`)

| Model | Status | Sizes | Best for |
|-------|--------|-------|----------|
| `gpt-image-2` | ✅ **Default · Recommended** | Arbitrary up to 4K (multiples of 16 px, ≤ 3:1 ratio) | Production — best quality, 4K, flexible resolution |
| `gpt-image-1.5` | ✅ Available | `1024×1024`, `1024×1536`, `1536×1024` | Compatibility / migration |
| `gpt-image-1-mini` | ✅ Available | `1024×1024`, `1024×1536`, `1536×1024` | High-volume, cost-sensitive pipelines |
| `gpt-image-1` | ✅ Available | `1024×1024`, `1024×1536`, `1536×1024` | Legacy workflows |
| `dall-e-2` | ⚠️ Variations only | `256×256`, `512×512`, `1024×1024` | Image variations endpoint only |
| ~~`dall-e-3`~~ | ⛔ **Retired 2026-03-04** | — | No longer available |

### Azure AI Foundry (`IMAGE_PROVIDER=azure`)

| Model | Status | Notes |
|-------|--------|-------|
| `gpt-image-2` | ✅ **Available · No access application needed** | Arbitrary resolution up to 4K. |
| `gpt-image-1.5` | ⚠️ Limited Access | Apply at [aka.ms/oai/gptimage1.5access](https://aka.ms/oai/gptimage1.5access) |
| `gpt-image-1-mini` | ⚠️ Limited Access | Apply at [aka.ms/oai/gptimage1access](https://aka.ms/oai/gptimage1access) |
| `gpt-image-1` | ⚠️ Limited Access | Apply at [aka.ms/oai/gptimage1access](https://aka.ms/oai/gptimage1access) |
| ~~`dall-e-3`~~ | ⛔ **Retired 2026-03-04** | Existing deployments are non-functional |

> 💡 **Azure users:** `gpt-image-2` is the easiest to start with — it requires no prior access approval today.  
> A 403 for gpt-image-1.x means you need to register at the links above.
>
> ℹ️ IMAGE_DEPLOYMENT selects the Azure default. The same server routes explicit MAI-Image-2.5 and gpt-image-2 requests to their respective adapters. See docs/authentication/TROUBLESHOOTING.md.

---

## gpt-image-2 Highlights

`gpt-image-2` (released **April 21, 2026**) is the flagship model and the recommended default:

| Feature | Detail |
|---------|--------|
| **Resolution** | Arbitrary — both edges must be multiples of **16 px**, max edge **3840 px (4K)**, max ratio **3:1**, pixel range **655 360 – 8 294 400** |
| **Quality** | `low` · `medium` · `high` · `auto` |
| **Output formats** | `png` (with transparency), `webp` (with transparency + compression), `jpeg` (compression) |
| **Background** | `transparent` · `opaque` · `auto` |
| **Images per request** | 1 – 10 (`n` parameter) |
| **Prompt length** | Up to **32 000 characters** |
| **Image editing inputs** | Up to **16 images** per edit request |
| **Streaming** | ✅ `stream: true`, `partial_images: 0–3` |
| **Variations** | ❌ Not supported (use `dall-e-2` for variations) |
| **Text rendering** | ✅ Excellent — infographics, banners, labels |
| **Photorealism** | ✅ Best-in-class — use keyword `photorealistic` in prompt |

**Popular resolution examples for gpt-image-2:**

| Use case | Resolution |
|----------|-----------|
| Square (general) | `1024×1024` |
| Portrait | `1024×1536` |
| Landscape | `1536×1024` |
| Widescreen / slides | `1536×864` |
| 2K / QHD _(reliability limit)_ | `2560×1440` |
| 4K / UHD _(experimental)_ | `3840×2160` |

---

## Tools Reference

### `image_generate`

```json
{
  "prompt": "A serene Japanese garden at dawn, photorealistic",
  "model": "gpt-image-2",
  "n": 1,
  "size": "1536x1024",
  "quality": "high",
  "background": "transparent",
  "output_format": "webp",
  "output_compression": 85,
  "save_to_workspace": false,
  "response_format": "markdown"
}
```

### `image_edit`

```json
{
  "image": "<base64-encoded-png>",
  "mask": "<base64-encoded-mask>",
  "prompt": "Add a red hat to the person",
  "model": "gpt-image-2"
}
```

### `image_variation`

```json
{
  "image": "<base64-encoded-square-png>",
  "n": 3,
  "size": "1024x1024"
}
```

> ⚠️ Variations use `dall-e-2` exclusively. Not supported by Azure OpenAI or any gpt-image-* model.

### `provider_validate`

```json
{ "provider": "openai" }
```

---

## Development

```bash
bun test                  # 305 tests
bun test --coverage       # with coverage report (≥ 92 %)
bun run lint              # ESLint
bun run type-check        # tsc --noEmit
bun run build             # compile to dist/
```

### Project Structure

```
src/
├── config/          # Joi-validated env config + models.ts (LATEST_MODEL)
├── mcp/
│   ├── tools/       # 5 MCP tools + Zod schemas
│   ├── features/    # Elicitation, Sampling, Roots
│   └── transport/   # HTTP (stateless) + stdio
├── providers/       # OpenAI + Azure + Together + Custom adapters
├── security/        # Auth guard, rate limiter, sanitiser
└── health/          # /health/* + /metrics
test/
├── unit/            # 240+ unit tests (mocked deps)
└── integration/     # 65+ integration tests (nock + supertest)
```

---

## Security

- API keys are **never** logged — masked with `***` in all output
- Input prompts sanitised (null bytes stripped, bidi control chars removed, length enforced)
- Path traversal prevented when saving to workspace roots
- Rate limiting: configurable per-client sliding window
- Optional bearer-token auth on the `/mcp` endpoint
- Container runs as **non-root** user (`mcpuser`)
- Trivy vulnerability scan on every CI build
- `bun audit` dependency audit on every CI build

See [`docs/SECURITY.md`](docs/SECURITY.md) for full threat model.

---

## Architecture

```
MCP Client (Claude / Goose / Cursor)
      │  JSON-RPC 2.0
      ▼
  POST /mcp  (Streamable HTTP)
  or stdio
      │
  ┌───┴────────────────────────────────┐
  │  NestJS Application                │
  │  ┌──────────┐  ┌────────────────┐  │
  │  │ 5 Tools  │  │ MCP Features   │  │
  │  │ schemas  │  │ Elicitation    │  │
  │  │ Zod val. │  │ Sampling       │  │
  │  └────┬─────┘  │ Roots          │  │
  │       │        └────────────────┘  │
  │  ┌────▼──────────────────────────┐ │
  │  │  IImageProvider               │ │
  │  │  OpenAI · Azure · Together    │ │
  │  │  Custom OpenAI-compatible     │ │
  │  └────┬──────────────────────────┘ │
  └───────┼────────────────────────────┘
          │  HTTPS
          ▼
  OpenAI API / Azure OpenAI
```

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for C4 diagrams and ADRs.

---

## Contributing

1. Fork → branch → implement with TDD (Red → Green → Refactor)
2. All PRs must have a failing-test commit before the implementation commit
3. Coverage must not drop below 90 %
4. Run `bun run lint && bun run type-check && bun test` before pushing

See [`docs/TDD_STRATEGY.md`](docs/TDD_STRATEGY.md) for the full TDD workflow.

---

## License

[CeCILL-2.1](./LICENSE) — a French open-source licence compatible with GNU GPL, endorsed by CEA, CNRS, and Inria.  
© 2026 PhD Jonathan MERCIER

### OpenRouter (Nano Banana 2 or MAI-Image-2.5)

OpenRouter is inferred from `https://openrouter.ai/api/v1`. Configure its key as `IMAGE_API_KEY`:

```bash
IMAGE_API_KEY=... npx --yes @bioinfornatics/image-mcp \
  --base-url https://openrouter.ai/api/v1 \
  --model google/gemini-3.1-flash-image \
  --transport stdio
```

See [`examples/goose-openrouter.yaml`](examples/goose-openrouter.yaml) and the capability table in [`docs/API.md`](docs/API.md#openrouter-image-api).


### Security policy notes

HTTP/multi-user workspace saving fails closed unless `IMAGE_WORKSPACE_ALLOWED_ROOTS` is configured; trusted stdio mode may accept client roots without it. Static Azure mode exposes only `IMAGE_DEPLOYMENT`; deployment discovery is required for selectable multi-deployment routing. Prometheus model labels are bounded canonical families and never contain raw requested or deployment names. See `docs/IMAGE_OBSERVABILITY.md` for strict usage and pricing validation, staleness, fallback, aggregation, and rounding policies.
