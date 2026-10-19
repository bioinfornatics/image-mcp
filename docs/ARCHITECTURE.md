# Architecture — image-mcp

**Version:** 1.0.0  
**Author:** Software Architect  
**Date:** 2026-04-22

---

## 1. System Context (C4 Level 1)

```
┌─────────────────────────────────────────────────────────────────────┐
│                         External Systems                            │
│                                                                     │
│   ┌──────────────────┐         ┌──────────────────────────────┐    │
│   │  OpenAI API      │         │  Azure OpenAI (AI Foundry)   │    │
│   │  /images/genera- │         │  /openai/deployments/{dep}/  │    │
│   │  tions, /edits   │         │  images/generations, /edits  │    │
│   └──────────────────┘         └──────────────────────────────┘    │
└──────────────────────────────────────────────────────────────────────┘
                 ▲                              ▲
                 │ HTTPS + API key              │ HTTPS + API key
                 │                              │
┌────────────────┴──────────────────────────────┴──────────────────────┐
│                        image-mcp Service                         │
│                    (Bun + NestJS + MCP SDK)                          │
└───────────────────────────────────────────────────────────────────────┘
                 ▲
                 │ MCP (JSON-RPC 2.0)
                 │ Streamable HTTP  or  stdio
                 │
┌────────────────┴─────────────────────────────────────────────────────┐
│                         MCP Clients                                  │
│         Claude Desktop │ Goose │ Cursor │ Custom LLM Agents          │
└──────────────────────────────────────────────────────────────────────┘
```

---

## 2. Container Diagram (C4 Level 2)

```
┌─────────────────────────────────────────────────────────────────────┐
│  image-mcp Container (OCI image: oven/bun + NestJS)             │
│                                                                     │
│  ┌──────────────────┐  ┌─────────────────────┐  ┌───────────────┐  │
│  │  Transport Layer │  │   NestJS Core        │  │ Provider Layer│  │
│  │                  │  │                      │  │               │  │
│  │ ┌──────────────┐ │  │ ┌─────────────────┐ │  │ ┌───────────┐ │  │
│  │ │ HTTP :3000   │─┼─▶│ │  McpModule      │─┼─▶│ │ OpenAI    │ │  │
│  │ │ POST /mcp    │ │  │ │  - ToolRegistry │ │  │ │ Provider  │ │  │
│  │ └──────────────┘ │  │ │  - Elicitation  │ │  │ └───────────┘ │  │
│  │ ┌──────────────┐ │  │ │  - Sampling     │ │  │ ┌───────────┐ │  │
│  │ │  stdio       │─┼─▶│ │  - Roots        │ │  │ │ Azure     │ │  │
│  │ └──────────────┘ │  │ └─────────────────┘ │  │ │ Provider  │ │  │
│  └──────────────────┘  │ ┌─────────────────┐ │  │ └───────────┘ │  │
│                         │ │ SecurityModule  │ │  └───────────────┘  │
│                         │ │ - RateLimitGuard│ │                     │
│                         │ │ - AuthGuard     │ │  ┌───────────────┐  │
│                         │ │ - Sanitiser     │ │  │ Observability │  │
│                         │ └─────────────────┘ │  │ /metrics      │  │
│                         │ ┌─────────────────┐ │  │ /health/live  │  │
│                         │ │  ConfigModule   │ │  │ /health/ready │  │
│                         │ │  (env + valid.) │ │  └───────────────┘  │
│                         │ └─────────────────┘ │                     │
│                         └─────────────────────┘                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 3. Module Structure (C4 Level 3)

### 3.1 Directory Layout

```
src/
├── main.ts                        # Bun entry point; selects transport
├── app.module.ts                  # Root NestJS module
│
├── config/
│   ├── config.module.ts           # ConfigModule (global)
│   ├── config.schema.ts           # Joi/class-validator env schema
│   └── config.service.ts          # Typed ConfigService wrapper
│
├── mcp/
│   ├── mcp.module.ts              # Registers tools + MCP features
│   ├── mcp.server.ts              # McpServer lifecycle wrapper
│   ├── transport/
│   │   ├── transport.factory.ts   # Picks HTTP vs stdio from env
│   │   ├── http.transport.ts      # Fastify + NodeStreamableHTTPServerTransport
│   │   └── stdio.transport.ts     # StdioServerTransport
│   ├── tools/
│   │   ├── image-generate.tool.ts
│   │   ├── image-edit.tool.ts
│   │   ├── image-variation.tool.ts
│   │   ├── provider-list.tool.ts
│   │   └── provider-validate.tool.ts
│   └── features/
│       ├── elicitation.service.ts
│       ├── sampling.service.ts
│       └── roots.service.ts
│
├── providers/
│   ├── providers.module.ts
│   ├── provider.interface.ts      # IImageProvider contract
│   ├── provider.factory.ts        # Creates provider from config
│   ├── openai/
│   │   ├── openai.provider.ts
│   │   └── openai.mapper.ts       # MCP params → OpenAI SDK params
│   └── azure/
│       ├── azure.provider.ts
│       └── azure.mapper.ts
│
├── security/
│   ├── security.module.ts
│   ├── rate-limit.guard.ts
│   ├── auth.guard.ts
│   └── sanitise.ts
│
└── health/
    ├── health.module.ts
    ├── health.controller.ts       # /health/live, /health/ready
    └── metrics.controller.ts      # /metrics (Prometheus)

test/
├── unit/                          # Mirrors src/ structure
├── integration/                   # Modules with mocked HTTP (nock/msw)
└── e2e/                           # Full MCP tool call flows
```

### 3.2 Core Interfaces

```typescript
// src/providers/provider.interface.ts
export interface IImageProvider {
  readonly name: 'openai' | 'azure';
  generate(params: GenerateParams): Promise<ImageResult[]>;
  edit(params: EditParams): Promise<ImageResult[]>;
  variation(params: VariationParams): Promise<ImageResult[]>;
  validate(): Promise<ValidationResult>;
}

export interface GenerateParams {
  prompt: string;
  model: string;
  n?: number;
  size?: string;
  quality?: string;
  background?: 'transparent' | 'opaque' | 'auto';
  output_format?: 'png' | 'jpeg' | 'webp';
  output_compression?: number;
  moderation?: 'auto' | 'low';
  stream?: boolean;
}

export interface ImageResult {
  b64_json: string;         // GPT image models always return b64
  revised_prompt?: string;  // reserved — null for all current models (dall-e-3 retired 2026-03-04)
  model: string;
  created: number;
}

export interface ValidationResult {
  valid: boolean;
  provider: string;
  error?: string;
}
```

---

## 4. MCP Protocol Integration

### 4.1 Capability Declaration

On `initialize`, the server declares:

```json
{
  "capabilities": {
    "tools": {},
    "elicitation": {},
    "logging": {}
  }
}
```

> **Note:** The server does NOT declare `sampling` or `roots` — those are **client** capabilities the server checks when deciding whether to send those requests back.

### 4.2 Elicitation Flow

```
Client                             Server (McpModule)
  │                                       │
  │  tools/call image_generate            │
  │  { prompt: "a cat" }  ─────────────▶ │
  │                                       │ (checks: client has elicitation cap?)
  │  ◀──── elicitation/create ──────────  │
  │  { message: "Refine your image",      │
  │    requestedSchema: {                 │
  │      properties: {                    │
  │        quality: { type: "string",     │
  │          enum: ["auto","high","low"]},│
  │        size: { type: "string", ... }  │
  │      }                                │
  │    }                                  │
  │  }                                    │
  │                                       │
  │  elicitation response  ─────────────▶ │
  │  { quality: "high", size: "auto" }    │
  │                                       │
  │                           [calls OpenAI API]
  │  ◀──── tools/call result  ──────────  │
```

### 4.3 Sampling Flow

```
Client                             Server
  │                                       │
  │  tools/call image_generate ─────────▶ │
  │  { prompt: "futuristic city" }        │
  │                                       │ (checks: client has sampling cap?)
  │  ◀──── sampling/createMessage ──────  │
  │  { messages: [                        │
  │      { role: "user",                  │
  │        content: "Enhance this image   │
  │        prompt for gpt-image-1:\n      │
  │        'futuristic city'" }           │
  │    ], maxTokens: 300 }                │
  │                                       │
  │  sampling response  ───────────────▶  │
  │  { role: "assistant",                 │
  │    content: "A sprawling futuristic   │
  │    megacity at dusk, neon lights,     │
  │    photorealistic, 8K..." }           │
  │                                       │
  │                     [enriched prompt used]
  │                           [calls OpenAI API]
  │  ◀──── tools/call result  ──────────  │
```

### 4.4 Roots Flow

```
Client                             Server
  │                                       │
  │  tools/call image_generate ─────────▶ │
  │  { prompt: "...",                     │
  │    save_to_workspace: true }          │
  │                                       │ (checks: client has roots cap?)
  │  ◀──── roots/list  ────────────────   │
  │                                       │
  │  roots/list response  ──────────────▶ │
  │  { roots: [                           │
  │      { uri: "file:///home/u/proj",    │
  │        name: "my-project" }           │
  │    ] }                                │
  │                                       │
  │              [saves to /home/u/proj/generated/]
  │  ◀──── tools/call result  ──────────  │
  │  { ..., savedTo: "/home/u/proj/       │
  │     generated/img_20260422_001.png" } │
```

---

## 5. Provider Abstraction

```
ProvidersModule
     │
     ├── ProviderFactory
     │     ├── reads IMAGE_PROVIDER env var
     │     ├── creates OpenAIProvider  (IMAGE_PROVIDER=openai)
     │     └── creates AzureOpenAIProvider  (IMAGE_PROVIDER=azure)
     │
     ├── OpenAIProvider
     │     └── new OpenAI({ apiKey, baseURL })  [openai npm SDK]
     │     └── implements IImageProvider
     │
     └── AzureOpenAIProvider
           └── new AzureOpenAI({ endpoint, apiKey, deployment, apiVersion })
           └── implements IImageProvider
```

Both providers use the official `openai` npm package. `AzureOpenAI` is a subclass of `OpenAI` with Azure-specific routing. The mapper functions translate MCP tool params → SDK params → normalized `ImageResult[]`.

---

## 6. Security Architecture

```
Incoming Request
       │
       ▼
┌────────────────────┐
│   Auth Guard       │  ← Checks Authorization: Bearer <IMAGE_MCP_API_KEY>
│   (if configured)  │    Returns 401 if wrong / missing
└─────────┬──────────┘
          ▼
┌────────────────────┐
│  Rate Limit Guard  │  ← Token bucket per client IP / MCP session
│                    │    Returns MCP error on exceeded
└─────────┬──────────┘
          ▼
┌────────────────────┐
│  Input Sanitiser   │  ← Strips null bytes, enforces length/encoding
│                    │    Path traversal prevention for file inputs
└─────────┬──────────┘
          ▼
┌────────────────────┐
│  MCP Tool Handler  │  ← Zod validation (rejects schema mismatches)
│                    │    Business logic + feature delegation
└─────────┬──────────┘
          ▼
┌────────────────────┐
│  Provider Layer    │  ← API key injected from ConfigService ONLY
│                    │    Keys masked in all log output (*** pattern)
└─────────┬──────────┘
          ▼
    OpenAI / Azure API
```

**Secret Masking Rule:** All `Logger` calls pass through a `maskSecrets()` interceptor that replaces strings matching known secret patterns (`sk-…`, 32+ char alphanumeric) with `***`. This is tested.

---

## 7. Transport Architecture

### Streamable HTTP (Default, Multi-Client)

```typescript
// Fastify is owned by Nest; @modelcontextprotocol/fastify supplies security hooks.
fastify.addHook('onRequest', hostHeaderValidation(allowedHosts));
fastify.addHook('onRequest', originValidation(allowedOrigins));

// One isolated server + transport per request — fully stateless.
app.post('/mcp', async (request, reply) => {
  const server = mcpServerFactory.createServer();
  const transport = new NodeStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  reply.raw.on('close', () => Promise.allSettled([transport.close(), server.close()]));
  await server.connect(transport);
  await transport.handleRequest(request.raw, reply.raw, request.body);
});
```

### stdio (Local / Single-Client)

```typescript
// Single transport; server runs as subprocess
const transport = new StdioServerTransport();
await mcpServer.connect(transport);
// NEVER log to stdout — use stderr only
```

**Transport selection** is controlled by the `IMAGE_MCP_TRANSPORT` env var (`http` | `stdio`, default: `http`).

---

## 8. Architecture Decision Records

### ADR-001: Bun as Runtime
- **Decision:** Bun ≥ 1.1 as the runtime
- **Rationale:** Native TS execution (no build step in dev), fast startup (~300ms vs ~1.5s for Node), first-class NestJS support, ships as a single binary for Docker
- **Trade-offs:** Younger ecosystem; some Node.js API edge-case differences
- **Status:** Accepted

### ADR-002: NestJS as Framework
- **Decision:** NestJS 12 (coordinated common/core/platform-fastify/testing versions)
- **Rationale:** DI container enables module isolation for TDD; well-tested in production; excellent TS support; modular architecture maps cleanly to our layer design; `@nestjs/testing` makes integration tests straightforward
- **Trade-offs:** More boilerplate than bare Express; ~1-2s startup overhead; Node.js 22+ is required by the NestJS 12 file-type dependency
- **Status:** Accepted

Nest Config 12 uses the custom validate callback to retain the existing Joi rules, coercion, defaults, unknown environment variables, and aggregate errors. Runtime dependencies must also pass the packed npm consumer audit; repository-only overrides are not a consumer security guarantee.

### ADR-003: MCP SDK v2 packages
- **Decision:** `@modelcontextprotocol/server`, `@modelcontextprotocol/node`, and `@modelcontextprotocol/fastify` v2
- **Rationale:** Uses the stable, framework-specific SDK packages and the official Fastify Host/Origin security hooks.
- **Trade-offs:** Requires Node.js 20+ and Zod 4.
- **Status:** Accepted

### ADR-004: Stateless Streamable HTTP Transport
- **Decision:** One `McpServer` and one `NodeStreamableHTTPServerTransport` instance per HTTP request
- **Rationale:** Isolates request IDs, client capabilities, feature calls, and transport lifecycle across concurrent sessions; simplifies horizontal scaling.
- **Trade-offs:** No persistent HTTP session state; each request is self-contained.
- **Status:** Accepted

### ADR-005: `openai` npm SDK for Both Providers
- **Decision:** Official `openai` npm package for both OpenAI and Azure OpenAI
- **Rationale:** SDK provides `AzureOpenAI` client class natively; single dependency; same API surface; Azure routing differences handled by the SDK, not custom code
- **Trade-offs:** Must pin SDK version to avoid breaking changes between releases
- **Status:** Accepted

### ADR-006: Zod v3 for Input Validation
- **Decision:** Zod v3 for MCP tool input schemas
- **Rationale:** MCP SDK v1.x uses Zod v3 internally — avoids peer dependency conflicts; excellent TS inference; used by all mcp-builder reference implementations
- **Trade-offs:** Zod v4 available but incompatible with SDK v1.x internals
- **Status:** Accepted

---

## 9. Deployment Topology

### Local Dev (stdio)
```
Claude Desktop ──stdio──▶ image-mcp (bun process)
```

### Standard (HTTP Server)
```
MCP Client ──HTTPS──▶ Reverse Proxy (nginx/Caddy) ──HTTP:3000──▶ image-mcp container
```

### Scaled (Kubernetes)
```
MCP Clients ──▶ Load Balancer ──▶ N × image-mcp pods (stateless)
                                        │
                                        ├── Prometheus scrapes /metrics
                                        └── Liveness/readiness → /health/*
```

---

*Architecture v1.0.0 — 2026-04-22*
