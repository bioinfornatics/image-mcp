# Agent Instructions — image-mcp

AI coding agent reference for the **image-mcp** project.  
Stack: **Bun ≥ 1.1 · NestJS 12 · TypeScript strict · MCP SDK v2**

---

## 1 — Development Commands

```bash
# Run (pick one)
bun run start:http          # HTTP transport on :3000 (MCP + REST)
bun run start:stdio         # stdio transport (Claude Desktop / Goose)
bun run start:dev           # HTTP, auto-restart on file change

# Test
bun test                    # all tests + coverage report
bun test --watch            # watch mode
bun test <path>             # single file

# Quality
bun run lint                # ESLint
bun run lint:fix            # ESLint --fix
bun run type-check          # tsc --noEmit
bun run format              # Prettier

# Build (produces dist/)
bun run build               # tsc -p tsconfig.build.json + chmod +x dist/main.js

# Keychain (keytar — optional backend)
bun run secret:store IMAGE_API_KEY      # store in OS keychain
bun run secret:store IMAGE_MCP_API_KEY

# Docker
docker build -t image-mcp .
docker run -p 3000:3000 \
  -e IMAGE_PROVIDER=openai \
  -e IMAGE_API_KEY=sk-... \
  image-mcp
```

**Quality gate — all three must pass before any commit:**
```bash
bun test && bun run type-check && bun run lint
```

---

## 2 — Project Architecture

```
src/
├── main.ts                       # Bootstrap: calls resolveSecrets() then NestFactory
├── app.module.ts                 # Root module: imports all feature modules
├── config/
│   ├── app.config.ts             # Joi schema + AppConfig type + factory
│   └── secret-loader.ts         # *_FILE / keytar / plain env resolution
├── mcp/
│   ├── mcp.module.ts             # Wires McpServerService + all tools + guards
│   ├── mcp.server.ts             # McpServer factory, registerTool() calls on init
│   ├── transport/
│   │   ├── http.controller.ts    # POST /mcp — stateless StreamableHTTP, per-request
│   │   └── stdio.bootstrap.ts   # McpStdioBootstrap: connect() + SIGINT/SIGTERM
│   ├── tools/
│   │   ├── schemas.ts            # All Zod schemas + enums (single source of truth)
│   │   ├── image-generate.tool.ts
│   │   ├── image-edit.tool.ts
│   │   ├── image-variation.tool.ts
│   │   ├── provider-list.tool.ts
│   │   └── provider-validate.tool.ts
│   └── features/
│       ├── elicitation.service.ts  # MCP Elicitation — requests params from client
│       ├── sampling.service.ts     # MCP Sampling — prompt enhancement via client LLM
│       └── roots.service.ts        # MCP Roots — workspace discovery + file save
├── providers/
│   ├── provider.interface.ts     # IImageProvider contract + PROVIDER_TOKEN
│   ├── providers.module.ts       # Factory: selects OpenAI or Azure from config
│   ├── openai/openai.provider.ts # generate / edit / variation / validate
│   └── azure/azure.provider.ts  # generate / edit / variation (throws) / validate
├── security/
│   ├── auth.guard.ts             # Bearer token guard (IMAGE_MCP_API_KEY, constant-time)
│   ├── rate-limit.guard.ts      # Per-session-ID sliding window, Prometheus tracked
│   └── sanitise.ts              # maskSecret / sanitisePrompt / validateFilePath
├── health/
│   ├── health.controller.ts      # GET /health/live  GET /health/ready
│   └── metrics.controller.ts    # GET /metrics — Prometheus text format
└── cli/
    └── store-secret.ts           # CLI: bun run secret:store <VAR>

test/
├── setup.ts                      # Global: sets stub env vars before any test
├── unit/                         # 175+ unit tests (mocked deps)
│   ├── config/                   # app.config.spec.ts · secret-loader.spec.ts
│   ├── health/                   # metrics.controller.spec.ts
│   ├── mcp/
│   │   ├── mcp.server.spec.ts
│   │   ├── features/             # elicitation / sampling / roots specs
│   │   └── tools/                # all 5 tools + image-generate.with-features.spec.ts
│   ├── providers/                # openai · azure · openai.edit-variation · azure.edit
│   └── security/                 # sanitise · auth.guard · rate-limit.guard
└── integration/
    ├── mcp/                      # http-transport · tools (all 5 via supertest)
    ├── providers/                # openai.provider (nock HTTP interception)
    └── security/                 # sanitisation end-to-end
```

---

## 3 — Key Design Decisions

### Secret resolution (startup order)
```
main.ts → resolveSecrets() → (keytar | *_FILE | plain env) → Joi validation → NestJS bootstrap
```
- `IMAGE_MCP_SECRET_BACKEND=file` (default) — reads `IMAGE_API_KEY_FILE` etc.
- `IMAGE_MCP_SECRET_BACKEND=keytar` — OS keychain first, then `_FILE` fallback
- `IMAGE_MCP_SECRET_BACKEND=env` — plain env vars only (dev opt-out)
- **Never** set `SECRET_BACKEND` — that is a reserved `libsecret` variable on Linux

### MCP tool registration
All tools call `(server as any).registerTool(name, meta, handler)` in their `register()` method.  
The `(server as any)` cast works around TS2589 deep-type instantiation from Zod + MCP SDK.

### Tool `execute()` signature
```typescript
async execute(rawParams: unknown, server?: unknown): Promise<ToolResult>
```
`server` is optional — all M4 features (Elicitation, Sampling, Roots) gracefully no-op when
`server` is `undefined`. The `register()` callback passes `extra?.server`.

### MCP protocol capabilities
- **Elicitation / Sampling / Roots** are **client** capabilities — the *client* declares them in
  `initialize`. The server checks `clientCapabilities.X` at runtime before calling them.
- The server advertises `{ tools: {}, logging: {} }` in its own capabilities.

### Transport
- **HTTP** (default): stateless, one `StreamableHTTPServerTransport` per request —
  horizontally scalable, no session state.
- **stdio**: single persistent connection, for Claude Desktop / Goose / Cursor.

### Response formats
All image tools return `response_format: "markdown"` (default) or `"json"`:
- `markdown` → `[{ type: "text", text: "# ..." }, { type: "image", data: b64, mimeType }]`
- `json` → `[{ type: "text", text: JSON.stringify({ model, count, images: [...] }) }]`

### Provider abstraction
```typescript
interface IImageProvider {
  name: string
  generate(params): Promise<ImageResult[]>
  edit(params): Promise<ImageResult[]>
  variation(params): Promise<ImageResult[]>  // Azure throws — not supported
  validate(): Promise<ValidationResult>
}
```
Injected as `PROVIDER_TOKEN`. Switch provider with `IMAGE_PROVIDER=openai|azure|together|custom` env var.

### Error handling
- All tool `execute()` methods catch and return
  `{ isError: true, content: [{ type: "text", text: "Error: ..." }] }`
- API keys are **never** in error messages — `maskSecret()` is called on all error strings
- Provider `normalizeError()` maps HTTP status codes to user-friendly messages
  (401 → auth, 403 → access denied / gpt-image-2 limited access, 429 → rate limit, 404 → not found)

### gpt-image-2 (Azure only)
Requires explicit access approval from Microsoft. A 403 response triggers a clear
"request access via Azure portal" error. The `provider_list` tool annotates it as `(limited access)`.

---

## 4 — Non-Obvious Gotchas

These are real pitfalls discovered during development that will bite you if you forget them.

### 4.1 HTTP transport requires a specific `Accept` header

Every `POST /mcp` request **must** include:
```
Accept: application/json, text/event-stream
```
The MCP SDK's `StreamableHTTPServerTransport` returns **HTTP 406** if either MIME type is missing.
This is enforced by `webStandardStreamableHttp.js` in the SDK. In tests, always use the helper:
```typescript
// test/integration/mcp/http-transport.integration.spec.ts
const MCP_ACCEPT = 'application/json, text/event-stream';
function mcpPost(srv, body) {
  return request(srv)
    .post('/mcp')
    .set('Accept', MCP_ACCEPT)
    .set('Content-Type', 'application/json')
    .send(body);
}
```
Plain `supertest` calls without this header will silently return 406 errors.

### 4.2 MCP SDK version installed is v1.29.0 (not v1.10.x from package.json)

`package.json` pins `^1.10.2`, but bun resolved `1.29.0`. The API changed significantly:

| What we use | Correct name in v1.29 | Notes |
|-------------|----------------------|-------|
| `(server as any).request(...)` | `server.elicitInput(params)` | Elicitation |
| `(server as any).request(...)` | `server.createMessage(params)` | Sampling |
| `(server as any).request(...)` | `server.listRoots(params)` | Roots |

The feature services currently use the low-level `server.request()` method with raw JSON-RPC
method strings. This works but bypasses the SDK's built-in client-capability checks. If the SDK
changes its internal wire format these calls will break silently. Prefer the named methods.

### 4.3 `extra.server` does not exist — `extra` is `RequestHandlerExtra`

In tool handler callbacks, `extra` is typed as `RequestHandlerExtra` which contains:
`{ signal, sessionId, requestInfo, authInfo }` — **no `.server` property**.

The `image-generate.tool.ts` currently reads `extra?.server` in the handler:
```typescript
async (params: unknown, extra?: Record<string, unknown>) => {
  const mcpServer = extra?.server as AnyServer | undefined;  // ← always undefined
  return self.execute(params, mcpServer);
}
```
This means Elicitation, Sampling, and Roots are **never triggered** from within a tool call
via this path. To actually invoke them, pass the `McpServer` instance captured in `register()`
via closure instead:
```typescript
register(server: McpServer) {
  const self = this;
  (server as any).registerTool('image_generate', meta,
    async (params: unknown) => self.execute(params, server)  // ← close over server
  );
}
```

### 4.4 Elicitation action is `"accept"`, not `"submit"`

The MCP spec (and SDK v1.29) defines elicitation result actions as:
```typescript
action: 'accept' | 'decline' | 'cancel'
```
Early drafts used `"submit"`. The old test fixtures in `tests/mcp-features.test.ts` (now removed)
used `"submit"`. Any new tests or mocks must use `"accept"`.

### 4.5 `"type": "module"` conflicts with CommonJS dist

`tsconfig.json` compiles to `module: "CommonJS"`. Adding `"type": "module"` to `package.json`
breaks `node dist/main.js` with `ReferenceError: exports is not defined`. It was removed.
Do **not** add it back. Use `.mjs` extensions explicitly if ESM output is ever needed.

### 4.6 `SECRET_BACKEND` is reserved by libsecret on Linux

The env var `SECRET_BACKEND` is used by `libsecret` (GNOME keyring backend selector).
Setting it to anything other than a valid libsecret value will crash or hang the secret service.
This project uses `IMAGE_MCP_SECRET_BACKEND` instead.

### 4.7 `(server as any).registerTool` — why the cast

`McpServer.registerTool()` is typed with deep Zod generics. TypeScript error TS2589
("Type instantiation is excessively deep") is triggered when NestJS decorators meet the
Zod inference. The `(server as any)` cast is the correct, intentional workaround.
Do not attempt to type it — the cast is load-bearing.

### 4.8 keytar is an `optionalDependency`

`keytar` requires native build tools (`libsecret-dev` on Linux, Xcode on macOS). It will
silently fail to install on Alpine-based Docker images and minimal CI runners. The server
always starts without it — `resolveKeytarSecrets()` catches import errors and falls back
to `_FILE` resolution. Never move keytar to `dependencies`.

### 4.9 Protocol version in integration tests

The SDK supports `['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05', '2024-10-07']`.
Integration tests use `protocolVersion: '2025-11-05'` — **this is not a real version** (note
day `05` vs month `06` or `03`). The SDK accepts it via negotiation fallback. Use a real version
string (`'2025-03-26'`) in new tests to avoid confusion.

### 4.10 `bun run <absolute-path>` crashes with `reflect-metadata` not loaded

When an MCP host (Goose, Claude Desktop) spawns the server from its own working directory:
```
bun run /abs/path/image-mcp/src/main.ts
```
Bun searches for `bunfig.toml` in the **current working directory** — which is the host's
directory, not the project root. `reflect-metadata` is never preloaded. NestJS decorators
(`@Post()`, `@Injectable()`, etc.) call `Reflect.defineMetadata()` at module-load time,
crashing with:
```
TypeError: undefined is not an object (evaluating 'descriptor.value')
```

**Fix:** Always use `bin/start.sh` as the entrypoint. It `cd`s to the project root first:
```bash
# bin/start.sh
cd "$(dirname "$0")/.."
exec bun run src/main.ts "$@"
```

**Goose config** must use `cmd: /abs/path/bin/start.sh`, not `cmd: bun` with args pointing
to `src/main.ts` directly. `node dist/main.js` is immune because it doesn't need `bunfig.toml`.

### 4.11 Bun test runner uses Jest-compatible API but is not Jest

`bun test` supports `jest.fn()`, `jest.mock()`, `jest.spyOn()`, but:
- `jest.mock()` hoisting works differently — declare mocks **before** the `import` of the
  module under test, or use `mock.module()` from `bun:test`
- `mock.module()` (Bun's own API) is more reliable for module-level mocks than `jest.mock()`
- `jest.useFakeTimers()` is **not** supported — avoid timer-dependent tests

---

## 5 — TDD Workflow

This project follows **Red → Green → Refactor** strictly.

1. Write a failing test first
2. Write the minimum implementation to make it pass
3. Refactor without breaking tests
4. Coverage must not drop below **90 % lines / 90 % functions**

```bash
bun test --watch    # keep running while writing
bun test --coverage # check thresholds before committing
```

**Test patterns:**
- Unit tests: mock all dependencies with `jest.fn()` / `jest.mock()`
- Integration tests: use `nock` for HTTP interception, `supertest` for NestJS HTTP
- Error paths: always test at least one failure case per method
- Security: API key masking tested explicitly (assert log output does not contain raw key)

**Commit message format:**
```
feat(scope): short description

- bullet of what changed
- test count: X pass / 0 fail
- coverage: N% lines
```

---

## 6 — Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `IMAGE_PROVIDER` | ✅ | — | `openai`, `azure`, `together`, or `custom` |
| `IMAGE_API_KEY` | ✅ | — | API key for the configured provider (or use `IMAGE_API_KEY_FILE`) |
| `IMAGE_API_KEY_FILE` | — | — | Path to file containing the key |
| `IMAGE_BASE_URL` | ✅ if azure/custom | — | Provider endpoint (e.g. `https://resource.openai.azure.com` for azure) |
| `IMAGE_DEPLOYMENT` | ✅ if azure | — | Azure deployment name |
| `IMAGE_API_VERSION` | — | `2025-04-01-preview` | Azure API version |
| `IMAGE_MODELS` | — | `custom` | Comma-separated model list (custom provider) |
| `IMAGE_MCP_TRANSPORT` | — | `http` | `http` or `stdio` |
| `IMAGE_PORT` | — | `3000` | HTTP listen port |
| `IMAGE_MCP_API_KEY` | — | — | Bearer token for `/mcp` endpoint (or use `_FILE`) |
| `IMAGE_MCP_API_KEY_FILE` | — | — | Path to file containing the MCP bearer token |
| `IMAGE_MCP_SECRET_BACKEND` | — | `file` | `file`, `keytar`, or `env` |
| `IMAGE_DEFAULT_MODEL` | — | `gpt-image-1` | Default image model |
| `IMAGE_USE_ELICITATION` | — | `true` | Enable MCP Elicitation |
| `IMAGE_USE_SAMPLING` | — | `true` | Enable MCP Sampling |
| `IMAGE_MAX_REQUESTS_PER_MINUTE` | — | `60` | Rate limit per client |
| `IMAGE_LOG_LEVEL` | — | `info` | `debug` / `info` / `warn` / `error` |

**Test environment** (set by `test/setup.ts` before any spec runs):
```
IMAGE_PROVIDER=openai · IMAGE_API_KEY=sk-test-fake-key-for-tests
IMAGE_MCP_TRANSPORT=http · IMAGE_PORT=3001 · IMAGE_LOG_LEVEL=error
```

---

## 7 — Docs & References

| File | Contents |
|------|----------|
| `docs/SPECIFICATION.md` | FR-001…010, NFR, acceptance criteria |
| `docs/ARCHITECTURE.md` | C4 diagrams, ADRs (6), deployment topologies |
| `docs/TDD_STRATEGY.md` | Test pyramid, coverage targets, patterns |
| `docs/API.md` | Full MCP tool API reference with examples |
| `docs/SECURITY.md` | Threat model, OWASP, incident response |
| `docs/TEAM_ROLES.md` | SA / BE / QA / SC / CD roles + RACI |
| `docs/MILESTONES.md` | M1–M6 milestones, US-001…020 user stories |
| `examples/claude-desktop-config.json` | 6 ready-to-paste Claude Desktop configs |
| `examples/goose-config.yaml` | 6 Goose config variants |

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:ca08a54f -->
---

## Beads Issue Tracker

Run `bd prime` for the full command reference and session close protocol.

### Rules
- Use `bd` for ALL task tracking — never TodoWrite / TaskCreate / markdown TODO lists
- Use `bd remember` for persistent knowledge — never MEMORY.md files
<!-- END BEADS INTEGRATION -->
