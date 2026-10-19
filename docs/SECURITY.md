# Security Guide

**Project:** image-mcp  
**Version:** 1.0  
**Date:** 2026-04-22  
**Status:** Active

---

## Table of Contents

1. [Overview & Threat Model Summary](#1-overview--threat-model-summary)
2. [Secret Management](#2-secret-management)
3. [Input Validation & Sanitisation](#3-input-validation--sanitisation)
4. [Transport Security](#4-transport-security)
5. [Authentication & Authorization](#5-authentication--authorization)
6. [MCP-Specific Security](#6-mcp-specific-security)
7. [Dependency Security](#7-dependency-security)
8. [Secrets Rotation](#8-secrets-rotation)
9. [Incident Response](#9-incident-response)
10. [Security Test Requirements](#10-security-test-requirements)
11. [OWASP Alignment](#11-owasp-alignment)

---

## 1. Overview & Threat Model Summary

### What This Server Does

`image-mcp` is a Model Context Protocol (MCP) server that exposes OpenAI image generation, editing, and variation APIs as structured MCP tools. It can be operated in two transport modes:

| Mode | Transport | Typical Caller |
|------|-----------|----------------|
| `stdio` | Standard I/O pipes | Local MCP host (Claude Desktop, VS Code extension) |
| `http` | HTTP/SSE or Streamable HTTP | Remote MCP clients, LLM agents |

### Assets at Risk

| Asset | Sensitivity | Impact if Compromised |
|-------|-------------|----------------------|
| `IMAGE_API_KEY` | Critical | Financial loss, quota abuse, generation of abusive content |
| `IMAGE_MCP_API_KEY` | High | Unauthorized tool invocation, prompt injection surface |
| User-supplied image files | Medium | Path traversal leading to file exfiltration |
| Generated image files written to workspace | Low–Medium | Overwrites or reads of unintended paths |
| System prompt / sampling context | Medium | Prompt injection influencing LLM behaviour |

### Threat Actors

| Actor | Vector | Likelihood |
|-------|--------|------------|
| Unauthenticated remote caller (HTTP mode) | Direct HTTP requests without a valid bearer token | High if port exposed |
| Malicious MCP tool argument | Crafted `prompt`, `save_to_workspace`, path strings | Medium — any connected LLM can pass arbitrary args |
| Prompt injection via upstream LLM | LLM constructs arguments designed to hijack server behaviour | Medium |
| Dependency supply-chain attack | Malicious package version in `node_modules` | Low–Medium |
| Container breakout / host file access | Path traversal in file-save operations | Low in sandboxed envs, medium otherwise |
| Credential leakage via logs | API key written to stdout/stderr/log files | Medium — common misconfiguration |

### Security Boundaries

```
┌──────────────────────────────────────────────────────────┐
│  MCP Host / LLM Agent                                    │
│  (trusted caller in stdio; untrusted in HTTP mode)       │
└────────────────────┬─────────────────────────────────────┘
                     │ MCP JSON-RPC (stdio or HTTPS)
                     ▼
┌──────────────────────────────────────────────────────────┐
│  image-mcp                                           │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────┐  │
│  │ Auth Guard   │  │ Input Validator│  │ Rate Limiter │  │
│  └──────┬───────┘  └──────┬───────┘  └───────┬───────┘  │
│         └─────────────────▼───────────────────┘          │
│                     Tool Handlers                         │
└────────────────────────────┬─────────────────────────────┘
                             │ HTTPS
                             ▼
                    api.openai.com
```

---

## 2. Secret Management

### 2.1 Allowed Storage Locations

| Location | Allowed | Notes |
|----------|---------|-------|
| Environment variables | ✅ Yes | Only supported method |
| `.env` file (not committed) | ✅ Yes | Must be in `.gitignore`; loaded at startup |
| Source code | ❌ Never | Fails pre-commit hook check |
| Log output (stdout/stderr) | ❌ Never | Masking rules apply — see §2.3 |
| MCP tool response | ❌ Never | Do not echo API keys in any tool output |
| `package.json` / config files | ❌ Never | Not secrets-safe |
| Docker image layers | ❌ Never | Use runtime env injection |

### 2.2 Required Environment Variables

| Variable | Purpose | Example Value |
|----------|---------|---------------|
| `IMAGE_API_KEY` | Authenticates requests to OpenAI | `sk-proj-…` |
| `IMAGE_MCP_API_KEY` | Guards the HTTP MCP server endpoint | Any high-entropy random string |

**Generating a strong `IMAGE_MCP_API_KEY`:**

```bash
openssl rand -base64 32
# or
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### 2.3 Secret Masking Rules

The server **must not** write any secret value to any output stream. The following patterns must be masked or elided:

1. **On startup validation** — log only the key prefix (first 6 chars) + `…REDACTED`:
   ```
   ✓ IMAGE_API_KEY loaded: sk-pro…REDACTED
   ```

2. **On error responses from OpenAI** — strip `Authorization` header values before logging the error object.

3. **In request/response debug traces** — strip headers matching:
   - `Authorization`
   - `x-api-key`
   - `api-key`

4. **In stack traces** — do not log process environment (`process.env`) dumps.

**Code pattern to sanitise before logging:**

```typescript
function sanitiseForLog(obj: unknown): unknown {
  if (typeof obj !== 'object' || obj === null) return obj;
  const copy = { ...(obj as Record<string, unknown>) };
  const secretKeys = /key|token|secret|password|auth/i;
  for (const k of Object.keys(copy)) {
    if (secretKeys.test(k)) copy[k] = '[REDACTED]';
    else copy[k] = sanitiseForLog(copy[k]);
  }
  return copy;
}
```

### 2.4 `.gitignore` Entries (Mandatory)

```
.env
.env.*
*.key
secrets/
```

---

## 3. Input Validation & Sanitisation

### 3.1 Prompt Injection

All text fields (`prompt`) passed to the OpenAI API are potentially adversarially controlled when the server is used in an agent pipeline.

**Mitigations:**

| Mitigation | Implementation |
|------------|----------------|
| Length cap | Reject prompts > 32 000 characters (OpenAI limit) |
| Structural validation | Validate against JSON schema before forwarding |
| Moderation passthrough | Pass `moderation` parameter to OpenAI; honour refusals |
| No server-side prompt augmentation containing secrets | Never inject API keys or server-internal data into prompts |

**What is NOT mitigated by the server** (responsibility of the MCP host):

- An upstream LLM constructing a harmful prompt — rely on OpenAI's content moderation.
- Jailbreaking instructions embedded in user messages — out of scope for this server.

### 3.2 Workspace Path and Link Safety

`save_to_workspace` is a boolean. Without an explicit path, the server obtains fresh MCP Roots and creates a random-name file under `<workspace>/generated`. Generation and editing also accept `workspace_output_path` relative to that directory (e.g. `design/target.png`, not `generated/design/target.png`). Explicit paths require `save_to_workspace=true` and a server connection. All requested `n` destinations are pinned to the first accepted root and preflighted before the provider call; unavailable, occupied or linked targets return an error, with no silent root/path fallback.

Security controls:

- only local `file:` roots are accepted; non-local authorities, UNC/network shares, HTTP and SMB are rejected;
- `file:///C:/...` and `file://localhost/C:/...` are normalized with Windows drive semantics;
- `IMAGE_WORKSPACE_ALLOWED_ROOTS` is split with the platform delimiter (`:` on POSIX, `;` on Windows);
- lexical confinement uses `path.relative`, including cross-drive and sibling-prefix rejection;
- the root and `generated` directory are checked with `lstat` and `realpath`;
- pre-existing symlinks and Windows junctions are rejected;
- explicit paths reject leading `generated/`, absolute paths, traversal, empty/dot components, backslashes, drive/stream syntax, reserved names, and trailing dots/spaces without normalization;
- explicit extensions must match `output_format` (default `png`); provider output format is checked again before writing;
- requested `n>1` uses `-1`, `-2`, etc. before the extension, independent of returned count;
- all destinations are checked for availability/collisions before the billed provider call and rechecked afterwards;
- writes use a same-directory UUID temporary file (`wx`, mode `0600`), sync it, and publish by exclusive atomic hard link; temporary files are cleaned on failure.

A provider-time collision fails without overwriting but may occur after billing. Preflight may create safe parent directories. Multiple outputs are individually atomic, not an all-or-nothing batch. No explicit path preserves automatic storage and best-effort random workspace copies; variation has no explicit path parameter.

A portable Node implementation cannot completely eliminate a concurrent local TOCTOU attack by a process that can replace directories between validation and open. Workspace roots should therefore be owned by the server user and not writable by untrusted local users.

Response semantics:

- `saved_to`: absolute path of the automatic persisted copy;
- `file_uri`: canonical `file:` URI for `saved_to`;
- `workspace_copy`: optional absolute path of the additional MCP Roots copy.

### 3.3 Image File Input Validation

For `image_edit` and `image_variation`, the caller provides an image (base64 or URL).

| Check | Rule |
|-------|------|
| File size | Reject base64 payloads decoding to > 20 MB (OpenAI limit) |
| MIME type | Accept only `image/png`, `image/jpeg`, `image/webp` |
| URL scheme | If URL provided, allow only `https://`; reject `file://`, `data:`, `javascript:` |
| URL host | Optionally restrict to allowlisted domains; always reject `localhost`, `169.254.0.0/16` (SSRF) |

### 3.4 General Field Validation

| Field | Type | Constraints |
|-------|------|-------------|
| `n` | integer | 1–10 (DALL-E 2), 1–1 (gpt-image-1) |
| `size` | enum | Must be one of the documented size strings |
| `quality` | enum | `auto` \| `high` \| `medium` \| `low` (gpt-image-1) or `hd` \| `standard` (DALL-E) |
| `output_format` | enum | `png` \| `jpeg` \| `webp` |
| `output_compression` | integer | 0–100 |
| `response_format` | enum | `markdown` \| `json` |

Unknown fields are stripped (not forwarded to OpenAI).

### 3.5 Null Byte Handling

All string fields must be checked for embedded null bytes (`\0`) before use:

```typescript
function rejectNullBytes(value: string, fieldName: string): void {
  if (value.includes('\0')) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Field '${fieldName}' contains invalid null byte`
    );
  }
}
```

---

## 4. Transport Security

### 4.1 HTTP Mode — TLS Requirements

When running in HTTP mode (`--transport http`), TLS is **mandatory** for any non-localhost deployment.

| Requirement | Detail |
|-------------|--------|
| TLS version | TLS 1.2 minimum; TLS 1.3 recommended |
| Certificate | Valid, unexpired, from trusted CA (Let's Encrypt acceptable) |
| Self-signed certs | Only permitted in CI/dev; never in production |
| Recommended deployment | Reverse proxy (nginx, Caddy) terminates TLS; server listens on `127.0.0.1` only |
| HSTS | Reverse proxy must set `Strict-Transport-Security: max-age=63072000; includeSubDomains` |

Forwarded headers are not trusted by default (`trustProxy: false`): client-IP rate limiting uses the directly connected peer. Behind a reverse proxy, clients therefore share its IP bucket. Any deployment-specific trust policy must validate known proxy addresses/CIDRs; do not use unconditional trust or a hop count alone, which permits direct clients to forge forwarded addresses.

**Caddy example (auto-TLS):**

```caddyfile
mcp.example.com {
  reverse_proxy 127.0.0.1:3000
}
```

**Nginx TLS snippet:**

```nginx
server {
    listen 443 ssl http2;
    ssl_certificate     /etc/letsencrypt/live/mcp.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/mcp.example.com/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_ciphers         HIGH:!aNULL:!MD5;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
    }
}
```

### 4.2 DNS Rebinding Protection (Local HTTP)

When the server listens locally (e.g., `127.0.0.1:3000`), a malicious web page can attempt DNS rebinding to bypass same-origin restrictions.

**Mitigations:**

1. **Host header validation** — reject requests whose `Host` header is not in an allowlist:
   ```typescript
   const ALLOWED_HOSTS = ['localhost', '127.0.0.1', '::1'];
   if (!ALLOWED_HOSTS.includes(req.headers.host?.split(':')[0])) {
     res.status(400).send('Invalid Host header');
     return;
   }
   ```

2. **Bind to `127.0.0.1` only** — never bind to `0.0.0.0` for local-only mode without explicit operator intent.

3. **Origin header check** — for browser-initiated requests, validate `Origin` header matches expected client origin.

### 4.3 stdio Mode Security Notes

In `stdio` mode, there is no network attack surface for remote callers. Security focus shifts to:

- **Process isolation:** The MCP host must launch the server as a least-privilege process.
- **No credential forwarding:** Do not pass `IMAGE_API_KEY` as a command-line argument (visible in `ps`); use environment variable injection.
- **Log files:** Ensure stdout/stderr are not redirected to world-readable files.

---

## 5. Authentication & Authorization

### 5.1 IMAGE_MCP_API_KEY Bearer Token Guard

In HTTP mode, every incoming MCP request must present a valid bearer token.

**Header format:**
```
Authorization: Bearer <IMAGE_MCP_API_KEY>
```

**Guard implementation:**

```typescript
function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const apiKey = process.env.IMAGE_MCP_API_KEY;
  if (!apiKey) {
    // No key configured — allow (dev mode only; log warning)
    console.warn('[SECURITY] IMAGE_MCP_API_KEY not set — running without authentication');
    return next();
  }

  const header = req.headers['authorization'] ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';

  // Constant-time comparison to prevent timing attacks
  const valid = token.length === apiKey.length &&
    timingSafeEqual(Buffer.from(token), Buffer.from(apiKey));

  if (!valid) {
    res.status(401).json({ error: 'Unauthorized', code: 'INVALID_API_KEY' });
    return;
  }
  next();
}
```

**Note:** `timingSafeEqual` from Node.js `crypto` module must be used to prevent timing-based key extraction.

### 5.2 Rate Limiting

Rate limiting is applied per client IP address to prevent abuse and denial-of-wallet attacks (excess OpenAI API spend).

| Tier | Limit | Window | Action on Exceed |
|------|-------|--------|-----------------|
| Default | 60 requests | 1 minute | 429 Too Many Requests |
| Image generation | 20 requests | 1 minute | 429 + `Retry-After` header |
| Image edit | 20 requests | 1 minute | 429 + `Retry-After` header |

**Recommended implementation:** `express-rate-limit` with in-memory or Redis store.

```typescript
import rateLimit from 'express-rate-limit';

const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests', code: 'RATE_LIMIT_EXCEEDED' },
});

const imageLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  keyGenerator: (req) => req.ip ?? 'unknown',
});
```

### 5.3 Authorization Scope

This server does not implement per-tool authorization scopes in v1. All authenticated callers have access to all tools. Future versions should implement scope-based authorization (e.g., read-only callers cannot use `image_generate`).

---

## 6. MCP-Specific Security

### 6.1 Elicitation Security

MCP Elicitation allows the server to request additional information from the user via a structured form presented by the MCP host.

**Rules:**

| Rule | Rationale |
|------|-----------|
| ❌ Never request secrets via elicitation | Elicitation responses may be logged by the MCP host |
| ❌ Never request API keys, passwords, or tokens | User may paste credentials into a form that is stored in conversation history |
| ✅ Only request non-sensitive operational parameters | E.g., image size preference, output format |
| ✅ Provide clear, non-misleading field labels | Prevent social-engineering the user into revealing data |
| ✅ Make all elicitation fields optional where possible | Reduce unnecessary data collection |

**Example of a safe elicitation use case:** Asking for a missing required `prompt` parameter when the caller omitted it.

**Forbidden elicitation patterns:**
```
// ❌ NEVER DO THIS
{
  "type": "elicitation/create",
  "params": {
    "message": "Please enter your API key",
    "requestedSchema": {
      "properties": {
        "api_key": { "type": "string" }  // ← FORBIDDEN
      }
    }
  }
}
```

### 6.2 Sampling Security

MCP Sampling allows the server to request the MCP host to make an LLM call on its behalf. This introduces a prompt-injection vector.

**Risks:**

| Risk | Description |
|------|-------------|
| Prompt injection via sampling response | The LLM response to a sampling request may contain adversarial instructions if the original user input is crafted to manipulate the LLM |
| Information leakage | Do not include sensitive server state in sampling prompts |
| Recursive sampling loops | Do not trigger sampling inside a sampling handler |

**Mitigations:**

1. **Treat sampling responses as untrusted data.** Parse and validate the structured content; do not execute it as code.
2. **Include only necessary context** in sampling prompts — do not include file system paths, environment variables, or internal server state.
3. **Set `maxTokens` conservatively** to limit cost and prevent large exfiltration payloads.
4. **Log sampling requests** (but not API keys) for audit purposes.

```typescript
// Safe sampling call — minimal context, structured response
const samplingRequest = {
  messages: [{
    role: 'user',
    content: {
      type: 'text',
      text: `Suggest an improved image prompt for: ${sanitisedUserPrompt}` // sanitised
    }
  }],
  maxTokens: 256,
  // Do NOT include: API keys, file paths, internal state
};
```

### 6.3 Roots Security

MCP Roots exposes the set of workspace directories the MCP host has granted to the server. This is used to determine where generated files may be saved.

**Security rules:**

1. **Treat `save_to_workspace` as a boolean**; optional generation/editing `workspace_output_path` is a validated relative path below `<workspace>/generated`, never an absolute destination.
2. **Roots must be absolute paths** — reject any root that is not absolute.
3. **Re-validate roots on each request** — roots may change between requests; do not cache indefinitely.
4. **If no roots are granted**, fail explicit destinations before the provider call rather than guessing a path. Requests without an explicit path retain automatic persistence and best-effort workspace copies.

The implementation canonicalizes local file URIs, validates the server allowlist, rejects links/junctions, and publishes workspace files exclusively and atomically with collision rechecks.

---

## 7. Dependency Security

### 7.1 npm Audit in CI

Every CI pipeline run (PR and main branch push) must include:

```yaml
# .github/workflows/ci.yml
- name: Security audit
  run: bun audit --audit-level=high
  # Fails CI if any HIGH or CRITICAL vulnerabilities found
```

The separate npm-consumer job runs node bin/verify-npm-consumer.mjs on Node 22 and 24. It builds and packs the actual archive, rejects development/secret paths, installs it with npm in a fresh temporary consumer project, and runs npm audit --omit=dev --audit-level=high. The consumer has no copied workspace configuration or overrides. Empty temporary npm configuration files and a minimal environment keep local registry credentials and provider secrets out of the check. Normal installation lifecycle scripts remain enabled to exercise real consumer installation.

The installed executable is tested via npx, including the package version, MCP initialization, tool discovery, and read-only provider listing with a fake OpenAI key (no live image generation). Container and publication jobs require this consumer job in addition to the repository audit.

**Why both audits are necessary:** npm ignores overrides declared by an installed dependency and does not inherit its repository lockfile. A green Bun audit therefore cannot prove that the published package installs a safe dependency tree. NestJS 12 and Config 12 fix the upstream runtime dependency constraints rather than depending on overrides in the consumer.

For moderate vulnerabilities, open a tracking issue but do not fail CI. Review weekly.

### 7.2 Trivy Container Scan

If a Docker image is built, scan it with [Trivy](https://github.com/aquasecurity/trivy) before pushing:

```yaml
- name: Trivy vulnerability scan
  uses: aquasecurity/trivy-action@<immutable-release-sha>
  with:
    image-ref: image-mcp:${{ github.sha }}
    format: table
    exit-code: 1
    severity: CRITICAL,HIGH
    vuln-type: os,library
```

### 7.3 Pinned Lockfile

- `bun.lock` must be committed.
- CI installs use `bun install --frozen-lockfile` to enforce lockfile integrity.

```bash
# Correct CI install
bun install --frozen-lockfile
```

`--ignore-scripts` prevents malicious postinstall scripts from running in CI.

### 7.4 Dependency Update Policy

| Severity | Action | Timeline |
|----------|--------|----------|
| CRITICAL | Immediate patch | Within 24 hours |
| HIGH | Scheduled patch | Within 7 days |
| MEDIUM | Next release cycle | Within 30 days |
| LOW | Backlog | Best effort |

Use `npm audit fix` for automated patches; review diffs before merging.

### 7.5 Supply Chain Integrity

- Enable npm provenance after npmjs Trusted Publishing is configured; until then npmjs publication remains explicitly gated.
- Consider `npm shrinkwrap` for deployment artifacts.
- Review new dependencies for: download count, maintainer reputation, license compatibility.

---

## 8. Secrets Rotation

### 8.1 Rotating `IMAGE_MCP_API_KEY`

Rotating the MCP API key causes a brief authentication interruption. Use this zero-downtime procedure:

**Step 1: Generate new key**
```bash
NEW_KEY=$(openssl rand -base64 32)
echo "New key: $NEW_KEY"  # Save securely — do not commit
```

**Step 2: Check server health before rotation**
```bash
curl -sf https://mcp.example.com/health || echo "Server unhealthy — investigate before rotating"
```

**Step 3: Update environment variable**

For Docker/Kubernetes:
```bash
# Update secret
kubectl create secret generic mcp-secrets \
  --from-literal=IMAGE_MCP_API_KEY="$NEW_KEY" \
  --dry-run=client -o yaml | kubectl apply -f -

# Rolling restart (zero-downtime)
kubectl rollout restart deployment/image-mcp
kubectl rollout status deployment/image-mcp
```

For `.env`-based deployment:
```bash
sed -i "s/^IMAGE_MCP_API_KEY=.*/IMAGE_MCP_API_KEY=$NEW_KEY/" /etc/image-mcp/.env
systemctl reload image-mcp  # or restart
```

**Step 4: Update all clients** with the new key.

**Step 5: Verify**
```bash
curl -H "Authorization: Bearer $NEW_KEY" https://mcp.example.com/health
```

**Step 6: Revoke old key** — after all clients are updated and verified.

### 8.2 Rotating `IMAGE_API_KEY`

1. Create a new key in the [OpenAI platform console](https://platform.openai.com/api-keys).
2. Deploy it via the same env var replacement process.
3. Verify with a test generation call.
4. Revoke the old key in the OpenAI console.
5. Monitor OpenAI usage dashboard for unexpected activity for 48 hours.

### 8.3 Rotation Schedule

| Secret | Recommended Rotation Frequency | Mandatory on Compromise |
|--------|--------------------------------|------------------------|
| `IMAGE_MCP_API_KEY` | Every 90 days | Immediately |
| `IMAGE_API_KEY` | Every 180 days | Immediately |

---

## 9. Incident Response

### 9.1 If `IMAGE_API_KEY` Is Leaked

**Immediate actions (within 1 hour):**

1. **Revoke the key immediately** at [https://platform.openai.com/api-keys](https://platform.openai.com/api-keys) — do not wait.
2. **Generate a new key** and deploy it.
3. **Review OpenAI usage logs** for the period of potential compromise — look for unexpected generations or API calls.
4. **Check for spend anomalies** in the OpenAI billing dashboard.
5. **Identify the leak source** — search git history, logs, Slack, CI output:
   ```bash
   git log --all -p | grep -E 'sk-[a-zA-Z0-9]{32,}'
   ```
6. **Remove from git history** if found committed (use `git-filter-repo` or BFG).
7. **Notify OpenAI support** if significant abuse is detected.

### 9.2 If `IMAGE_MCP_API_KEY` Is Leaked

**Immediate actions:**

1. **Rotate the key** using the procedure in §8.1.
2. **Review server access logs** for unauthorized tool calls.
3. **Assess impact** — were any images generated? Were workspace files written?
4. **Check for prompt injection traces** in logs.

### 9.3 If a Path Traversal Attack Is Suspected

1. **Review file system** for unexpected files outside workspace roots.
2. **Review server logs** for suspicious `save_to_workspace` values.
3. **Check process audit logs** (`auditd`) for unexpected file writes.
4. **Patch** — ensure validation in §3.2 is deployed.
5. **File a bug report** against this project.

### 9.4 Communication

| Audience | Channel | Timeline |
|----------|---------|----------|
| Internal team | Slack #security-incidents | Immediately |
| Service owner | Direct message + email | Within 30 minutes |
| Affected users | Email notification | Within 24 hours (if user data affected) |
| Public disclosure | GitHub Security Advisory | After patch is deployed |

---

## 10. Security Test Requirements

The following security-focused tests **must** exist and pass in CI.

### 10.1 Unit Tests

| Test ID | Description | Expected Result |
|---------|-------------|-----------------|
| SEC-001 | Log output when API key is set does not contain the raw key value | Pass — key masked in all log output |
| SEC-002 | `workspace_output_path` traversal is rejected | Tool error before provider call |
| SEC-003 | `workspace_output_path` with null byte is rejected | Tool error before provider call |
| SEC-004 | Absolute `workspace_output_path` is rejected | Tool error before provider call |
| SEC-005 | Request with invalid `IMAGE_MCP_API_KEY` returns HTTP 401 | `{ error: 'Unauthorized' }` |
| SEC-006 | Request without `Authorization` header returns HTTP 401 when key is configured | HTTP 401 |
| SEC-007 | Rate limit enforced after 20 image_generate calls in 60s | HTTP 429 with `Retry-After` |
| SEC-008 | `prompt` field over 32 000 characters is rejected | `McpError` with `InvalidParams` |
| SEC-009 | Image URL with `file://` scheme is rejected | `McpError` with `InvalidParams` |
| SEC-010 | Image URL pointing to `169.254.169.254` (SSRF) is rejected | `McpError` with `InvalidParams` |
| SEC-011 | Elicitation never requests fields named `key`, `token`, `password`, `secret` | Static analysis / schema test |
| SEC-012 | `timingSafeEqual` used for API key comparison (not `===`) | Code review / AST check |
| SEC-013 | DNS rebinding: request with `Host: evil.com` rejected in local mode | HTTP 400 |
| SEC-014 | `output_format` with disallowed value is rejected before forwarding | `McpError` with `InvalidParams` |
| SEC-015 | `n` parameter outside allowed range is rejected | `McpError` with `InvalidParams` |

### 10.2 Integration Tests

| Test ID | Description |
|---------|-------------|
| SEC-I01 | Full generate flow — verify no API key in response body or headers |
| SEC-I02 | File saved via `save_to_workspace` stays within workspace root |
| SEC-I03 | Server starts without `IMAGE_MCP_API_KEY` and logs a warning (not an error) |
| SEC-I04 | `npm audit` exits 0 on clean dependency tree |

### 10.3 Running Security Tests

```bash
# Unit tests only
npm test -- --grep "SEC-"

# Full security suite
npm run test:security

# npm audit
npm audit --audit-level=high
```

---

## 11. OWASP Alignment

The following table maps relevant [OWASP Top 10 (2021)](https://owasp.org/www-project-top-ten/) categories to this project.

| # | OWASP Category | Applicable? | How Mitigated in image-mcp |
|---|---------------|-------------|-------------------------------|
| A01 | Broken Access Control | ✅ Yes | `IMAGE_MCP_API_KEY` bearer token; path traversal checks; workspace root enforcement |
| A02 | Cryptographic Failures | ✅ Yes | TLS required for HTTP; `timingSafeEqual` for key comparison; secrets never in plaintext logs |
| A03 | Injection | ✅ Yes | Prompt injection mitigations; input schema validation; null byte rejection; path sanitisation |
| A04 | Insecure Design | ✅ Yes | Threat model documented; security tests required; elicitation rules prevent credential collection |
| A05 | Security Misconfiguration | ✅ Yes | No default credentials; startup warnings for missing keys; `.gitignore` rules; `--ignore-scripts` in CI |
| A06 | Vulnerable & Outdated Components | ✅ Yes | `npm audit` in CI; Trivy scan; pinned lockfile; rotation schedule |
| A07 | Identification & Authentication Failures | ✅ Yes | Bearer token auth; rate limiting; constant-time comparison |
| A08 | Software & Data Integrity Failures | ✅ Yes | Pinned `bun.lock`, frozen installs, immutable action SHAs, audit and container scanning |
| A09 | Security Logging & Monitoring Failures | ✅ Yes | Secret masking in logs; access log requirements; incident response procedures |
| A10 | Server-Side Request Forgery (SSRF) | ✅ Yes | URL scheme allowlist; block `169.254.0.0/16`; reject `file://` and `localhost` image URLs |

### LLM-Specific Risks (OWASP LLM Top 10)

| # | Category | Applicable? | Mitigation |
|---|----------|-------------|------------|
| LLM01 | Prompt Injection | ✅ Yes | Treat all prompt content as untrusted; rely on OpenAI moderation |
| LLM02 | Insecure Output Handling | ✅ Yes | Validate/parse sampling responses; do not exec content |
| LLM06 | Sensitive Information Disclosure | ✅ Yes | Secret masking; elicitation rules; no secrets in sampling prompts |
| LLM09 | Overreliance | ⚠️ Partial | Sampling responses validated as structured data, not acted on blindly |

---

*This document is maintained alongside the source code. When security controls change, update this document in the same PR.*

*For vulnerability reports, open a [GitHub Security Advisory](https://github.com/YOUR_ORG/image-mcp/security/advisories/new) — do not file public issues for security vulnerabilities.*
