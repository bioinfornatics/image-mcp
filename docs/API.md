# MCP Tools API Reference

**Project:** image-mcp  
**Protocol:** Model Context Protocol (MCP) — JSON-RPC 2.0  
**Package version:** 0.2.0  
**Reference revision:** 0.2.0  
**Date:** 2026-08-19  
**Status:** Active

---

## Table of Contents

1. [Overview](#1-overview)
2. [Common Conventions](#2-common-conventions)
3. [Tools Reference](#3-tools-reference)
   - [image_generate](#31-image_generate)
   - [image_edit](#32-image_edit)
   - [image_variation](#33-image_variation)
   - [provider_list](#34-provider_list)
   - [provider_validate](#35-provider_validate)
4. [MCP Protocol Features](#4-mcp-protocol-features)
   - [Elicitation](#41-elicitation)
   - [Sampling](#42-sampling)
   - [Roots](#43-roots)
5. [Error Reference](#5-error-reference)

---

## 1. Overview

`image-mcp` exposes **5 MCP tools** that provide structured access to OpenAI's image generation, editing, and variation APIs, as well as provider introspection utilities.

### Exposed Tools

| Tool | Category | Description |
|------|----------|-------------|
| `image_generate` | Generation | Create images from a text prompt |
| `image_edit` | Editing | Edit an existing image using a prompt (and optional mask) |
| `image_variation` | Variation | Generate variations of an existing image |
| `provider_list` | Introspection | List all configured image providers and their models |
| `provider_validate` | Introspection | Validate that a specific provider is correctly configured |

### Transport Modes

| Mode | Description |
|------|-------------|
| `stdio` | Standard I/O — used with Claude Desktop, VS Code MCP extensions |
| `http` | HTTP/SSE or Streamable HTTP — used with remote MCP clients and agents |

### Protocol

All tools are invoked via MCP's `tools/call` method, which wraps a standard **JSON-RPC 2.0** request. The server negotiates capabilities during the `initialize` handshake.

---

## 2. Common Conventions

### 2.1 response_format Enum

Every tool that returns image data accepts a `response_format` parameter controlling the shape of the tool result:

| Value | Description |
|-------|-------------|
| `markdown` | Returns a human-readable Markdown string with embedded image data and metadata (default) |
| `json` | Returns a structured JSON object — preferred for agent pipelines that need to process image data programmatically |

### 2.2 Error Format

When a tool call fails, the MCP server returns a tool result with `isError: true`:

```json
{
  "content": [
    {
      "type": "text",
      "text": "Error [ERROR_CODE]: Human-readable description of the error."
    }
  ],
  "isError": true
}
```

For JSON `response_format`, errors are also returned as structured objects — see §5 for all error codes.

### 2.3 Base64 Image Encoding

Generated images are returned as base64-encoded strings within MCP `image` content blocks:

```json
{
  "type": "image",
  "data": "<base64-encoded image bytes>",
  "mimeType": "image/png"
}
```

The `mimeType` reflects the verified response bytes (for example `image/png`, `image/jpeg`, or `image/webp`), even if a provider ignores the requested format.

### 2.4 Workspace File Saving

`save_to_workspace` is a boolean. When `true`, the server creates additional copies under `<workspace>/generated`, using random filenames by default. Every image is also persisted automatically in `IMAGE_OUTPUT_DIR` or the platform Images/Pictures directory.

For `image_generate` and `image_edit`, set `workspace_output_path` with `save_to_workspace: true` to choose a path **relative to `<workspace>/generated`**. For example, `design/target.png` saves to `<workspace>/generated/design/target.png`; do **not** include a leading `generated/` (`generated/design/target.png` is rejected, not normalized). The extension must exactly match `output_format` (`.png` when omitted). Absolute paths, traversal, empty/dot components, backslashes, platform-unsafe names (including drive/stream syntax and trailing dots/spaces), existing destinations, and symlink/junction components are rejected.

For requested `n > 1`, suffixes `-1`, `-2`, etc. are inserted before the extension (`design/target-1.png`, `design/target-2.png`). Names use requested `n` even if the provider returns fewer outputs; response entries remain aligned with provider output indexes.

Explicit destinations require an MCP server connection and an accepted local root. Every destination is preflighted **before the provider call**; unavailable roots/directories, occupied files and links fail closed, without trying a different root or silently returning only automatic storage. Destinations are pinned to the first accepted root and rechecked when writing, then atomically published exclusively. Provider-time collisions or a provider returning a different format produce an error without overwriting the target (the provider call may already be billed). Parent directories may be created during preflight; multi-output writes are individually atomic, not a batch transaction. Without an explicit path, automatic storage and best-effort random-name workspace copies retain their previous behavior. Variation has no explicit destination parameter.

### 2.5 Units & Limits

| Parameter | Unit | Notes |
|-----------|------|-------|
| `output_compression` | Integer 0–100 | Provider-specific JPEG/WebP control; omit unless the selected adapter documents support |
| `n` | Integer | Number of images to generate in one call |
| Prompt length | Characters | Maximum 32 000 characters |
| Image payload | Bytes | Maximum 20 MB decoded |

---

## 3. Tools Reference

---

### 3.1 `image_generate`

#### Description

Generates one or more images from a text prompt using OpenAI or Azure OpenAI `gpt-image-*` models. `gpt-image-2` is the recommended default.

**When to use:**
- Creating new images from scratch based on a text description.
- Generating multiple images in a single call (`n` up to 10).
- Producing images in specific formats, sizes, or with transparent backgrounds.

#### Input Schema

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `prompt` | string | ✅ Yes | — | Text description of the image to generate. Max 32 000 chars. |
| `model` | string | No | provider default | Model or deployment. Omit it to use the configured provider default. |
| `n` | integer | No | `1` | Number of images to generate (1–10). All `gpt-image-*` models support up to 10. |
| `size` | string | No | `auto` | Image dimensions. See model-specific size table below. |
| `quality` | string | No | `auto` | Quality setting. `auto`\|`high`\|`medium`\|`low` (gpt-image-* models). |
| `background` | string | No | `auto` | Background transparency. `transparent`\|`opaque`\|`auto`. Supported on `gpt-image-*` with `png` or `webp` output. |
| `output_format` | string | No | `png` | Output image format. `png`\|`jpeg`\|`webp` |
| `output_compression` | integer | No | `100` | Compression level 0–100 for `jpeg` and `webp` output formats |
| `moderation` | string | No | `auto` | GPT image moderation level. `low` requires the server opt-in `IMAGE_ALLOW_LOW_MODERATION=true`. |
| `fallback_model` | string | No | — | Explicit `gpt-image-2` fallback after an output-stage safety block; never used for prompt-stage blocks. |
| `skip_elicitation` | boolean | No | `false` | Skip interactive size/quality elicitation. |
| `save_to_workspace` | boolean | No | `false` | Create additional copies under `<workspace>/generated` |
| `workspace_output_path` | string | No | — | Relative to `<workspace>/generated`; requires `save_to_workspace=true`; see §2.4 |
| `response_format` | string | No | `markdown` | Tool response format. `markdown`\|`json` |

**Size options by model:**

| Model | Supported Sizes |
|-------|----------------|
| `gpt-image-2` | `auto`, presets (`1024x1024`, `1536x1024`, `1024x1536`), or **arbitrary `WxH`** — see constraints below |
| `gpt-image-1.5` | `1024x1024`, `1536x1024`, `1024x1536`, `auto` |
| `gpt-image-1-mini` | `1024x1024`, `1536x1024`, `1024x1536`, `auto` |
| `gpt-image-1` | `1024x1024`, `1536x1024`, `1024x1536`, `auto` |
| `MAI-Image-2.5` | `auto` (= `1024x1024`) or `WxH` with both edges ≥ 768 and total pixels ≤ 1,048,576; PNG output; omit quality |
| `dall-e-2` | `256x256`, `512x512`, `1024x1024` — variations only |
| ~~`dall-e-3`~~ | ⛔ Retired 2026-03-04 |

**gpt-image-2 arbitrary resolution (`image_generate` and `image_edit`):** the `size` field
accepts any `WxH` string (e.g. `"2048x1152"`) in addition to `auto` and the three fixed presets,
validated against 4 constraints:

- Both edges must be multiples of **16**
- Max edge must be **< 3840**
- Aspect ratio must be **≤ 3:1**
- Total pixel count must be between **655,360** and **8,294,400**

Requests are rejected with a descriptive Zod validation error identifying which constraint failed
(e.g. `"Width 1025 is not a multiple of 16."`, `"Aspect ratio 3.02:1 exceeds the maximum of 3:1..."`).

Sizes with a pixel count **above 2,560×1,440** (3,686,400 px) are valid but trigger an
**experimental resolution warning**: a markdown blockquote in the tool's text response
(`response_format: markdown`), or a top-level `"warning"` field in the JSON response
(`response_format: json`). This threshold is exactly at `2560x1440` inclusive (not experimental)
and exceeded starting at the next multiple-of-16 step. Output quality/reliability for gpt-image-2
is documented as more variable above this boundary; the warning is advisory only and does not
block the request.

#### Output Contract

The MCP result contains one text block, then an `image` block and a `resource_link` for each image. Base64 bytes are in the native `image` block, not inside text JSON.

With `response_format: json`, the text block contains:

```json
{
  "model": "gpt-image-2",
  "requested_model": "gpt-image-2",
  "effective_model": "gpt-image-2",
  "fallback_used": false,
  "count": 1,
  "images": [{
    "index": 0,
    "saved_to": "/home/user/Images/image-mcp/img.png",
    "file_uri": "file:///home/user/Images/image-mcp/img.png",
    "created": 1700000000
  }]
}
```

An explicit successful fallback adds `fallback_reason`; a workspace copy adds `workspace_copy`.

#### Error Cases

| Error Code | HTTP Equiv | Condition |
|------------|-----------|-----------|
| `MISSING_REQUIRED_PARAM` | 400 | `prompt` not provided |
| `INVALID_PARAM` | 400 | `size` not valid for the selected model |
| `INVALID_PARAM` | 400 | `n` > 10 |
| `INVALID_PARAM` | 400 | `background: transparent` with `jpeg` output |
| `INVALID_PARAM` | 400 | `output_compression` out of range 0–100 |
| `OPENAI_ERROR` | 502 | OpenAI API returned an error (content policy, quota, etc.) |
| `PROVIDER_NOT_CONFIGURED` | 503 | `IMAGE_API_KEY` is not set |
| `RATE_LIMIT_EXCEEDED` | 429 | Client has exceeded per-minute rate limit |

#### Example MCP Call

```json
{
  "jsonrpc": "2.0",
  "id": "req-001",
  "method": "tools/call",
  "params": {
    "name": "image_generate",
    "arguments": {
      "prompt": "A photorealistic landscape painting of misty mountains at dawn, oil on canvas style",
      "model": "gpt-image-1",
      "size": "1536x1024",
      "quality": "high",
      "output_format": "png",
      "background": "opaque",
      "save_to_workspace": true,
      "response_format": "json"
    }
  }
}
```

**Response:**

```json
{
  "jsonrpc": "2.0",
  "id": "req-001",
  "result": {
    "content": [
      {
        "type": "text",
        "text": "{\"success\":true,\"model\":\"gpt-image-1\",\"images\":[{\"index\":0,\"data\":\"iVBORw0KGgo...\",\"mimeType\":\"image/png\",\"size\":\"1536x1024\",\"savedTo\":\"/workspace/outputs/mountain_dawn.png\"}]}"
      }
    ],
    "isError": false
  }
}
```

---

### 3.2 `image_edit`

#### Description

Edits an existing image based on a text prompt. Optionally accepts a mask image to restrict edits to specific regions. Useful for inpainting, background replacement, and targeted modifications.

**When to use:**
- Modifying a specific region of an existing image.
- Adding, removing, or replacing elements in an image.
- Changing the style or content of selected areas using a transparency mask.

**Model support:** All `gpt-image-*` models (full support). `dall-e-2` (limited — mask required, PNG only, square images only). `dall-e-3` was retired 2026-03-04.

#### Input Schema

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `image` | string | No¹ | — | Base64-encoded image data or HTTPS URL of the image to edit. PNG, JPEG, or WebP. Max 20 MB. |
| `images` | string[] | No¹ | — | Array of base64-encoded images for multi-image compositing (e.g. virtual try-on, person-in-scene, style transfer). Use instead of `image`. Max 16 images, 10 MB aggregate payload cap (enforced regardless of image count). Provider-independent — supported identically on OpenAI and Azure. |
| `mask` | string | No | — | Base64-encoded mask image or HTTPS URL. Transparent areas indicate regions to edit. Must be same dimensions as `image`. PNG only. |
| `prompt` | string | ✅ Yes | — | Description of the desired edit. Max 32 000 chars. |
| `model` | string | No | provider default | Model or deployment; omit to use the configured provider default. |
| `n` | integer | No | `1` | Number of edited images to generate (1–10). |
| `size` | string | No | `auto` | Output image dimensions. See model size table in §3.1. |
| `quality` | string | No | `auto` | Quality setting. See model quality options in §3.1. |
| `output_format` | string | No | `png` | Output format. `png`\|`jpeg`\|`webp` |
| `output_compression` | integer | No | `100` | Compression level 0–100 for `jpeg`/`webp` |
| `save_to_workspace` | boolean | No | `false` | Create additional copies under `<workspace>/generated` |
| `workspace_output_path` | string | No | — | Relative to `<workspace>/generated`; requires `save_to_workspace=true`; see §2.4 |
| `response_format` | string | No | `markdown` | Tool response format. `markdown`\|`json` |

¹ Exactly one of `image` or `images` must be provided (mutually exclusive; both-provided and neither-provided are rejected at the schema layer).

#### Output Contract

The MCP result contains text plus native `image` and `resource_link` blocks. With `response_format: json`, the text block contains `count` and image entries with `model`, `created`, `saved_to`, `file_uri`, and optional `workspace_copy`.

#### Error Cases

| Error Code | Condition |
|------------|-----------|
| `MISSING_REQUIRED_PARAM` | `image` or `prompt` not provided |
| `INVALID_PARAM` | Image URL uses non-HTTPS scheme |
| `INVALID_PARAM` | Image exceeds 20 MB |
| `INVALID_PARAM` | Mask dimensions differ from image dimensions |
| `INVALID_PARAM` | `dall-e-2` used with non-PNG or non-square image |
| `INVALID_PARAM` | `n` > 1 with `gpt-image-1` |
| `OPENAI_ERROR` | OpenAI API error (content policy, format error, etc.) |
| `PROVIDER_NOT_CONFIGURED` | `IMAGE_API_KEY` not set |

#### Example MCP Call

```json
{
  "jsonrpc": "2.0",
  "id": "req-002",
  "method": "tools/call",
  "params": {
    "name": "image_edit",
    "arguments": {
      "image": "https://example.com/original.png",
      "mask": "iVBORw0KGgo...",
      "prompt": "Replace the cloudy sky with a bright blue sky with a few white clouds",
      "model": "gpt-image-1",
      "size": "1024x1024",
      "quality": "high",
      "output_format": "png",
      "save_to_workspace": true,
      "response_format": "json"
    }
  }
}
```

---

### 3.3 `image_variation`

#### Description

Generates one or more variations of an existing image without a text prompt. Useful for exploring creative alternatives to a reference image.

**⚠️ `dall-e-2` only.** This endpoint is not supported by any `gpt-image-*` model. Calls to this tool always use `dall-e-2`. `dall-e-3` was retired 2026-03-04.

**When to use:**
- Generating creative alternatives to an existing image.
- Exploring visual variations of a design concept.
- Producing multiple style variants from a reference.

#### Input Schema

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `image` | string | ✅ Yes | — | Base64-encoded PNG image or HTTPS URL. Must be square. Max 20 MB. |
| `n` | integer | No | `1` | Number of variations to generate. Range: 1–10. |
| `size` | string | No | `1024x1024` | Output size. One of: `256x256`, `512x512`, `1024x1024` |
| `save_to_workspace` | boolean | No | `false` | Create additional random-name copies under `<workspace>/generated` |
| `response_format` | string | No | `markdown` | Tool response format. `markdown`\|`json` |

> **Note:** `output_format`, `quality`, `background`, and `prompt` are not accepted by this tool. DALL-E 2 always returns PNG at the requested size.

#### Output Contract

The MCP result contains text plus native `image` and `resource_link` blocks. With `response_format: json`, the text block contains `count` and image entries with `model`, `created`, `saved_to`, `file_uri`, and optional `workspace_copy`.

#### Error Cases

| Error Code | Condition |
|------------|-----------|
| `MISSING_REQUIRED_PARAM` | `image` not provided |
| `INVALID_PARAM` | Image is not square (DALL-E 2 requirement) |
| `INVALID_PARAM` | Image is not PNG format |
| `INVALID_PARAM` | Image exceeds 20 MB |
| `INVALID_PARAM` | `n` outside range 1–10 |
| `INVALID_PARAM` | `size` not one of `256x256`, `512x512`, `1024x1024` |
| `OPENAI_ERROR` | OpenAI API error |
| `PROVIDER_NOT_CONFIGURED` | `IMAGE_API_KEY` not set |

#### Example MCP Call

```json
{
  "jsonrpc": "2.0",
  "id": "req-003",
  "method": "tools/call",
  "params": {
    "name": "image_variation",
    "arguments": {
      "image": "iVBORw0KGgo...",
      "n": 4,
      "size": "512x512",
      "save_to_workspace": true,
      "response_format": "json"
    }
  }
}
```

---

### 3.4 `provider_list`

Returns the active provider, its effective default, and the models/deployments that this server can route. It accepts no parameters.

The tool returns human-readable text plus `structuredContent`:

```json
{
  "configured_provider": "azure",
  "default_model": "MAI-Image-2.5",
  "providers": [{
    "name": "azure",
    "configured": true,
    "available_models": ["MAI-Image-2.5", "gpt-image-2"],
    "status": "configured"
  }]
}
```

With Foundry discovery enabled, `available_models` contains only discovered supported image deployments.

#### Example MCP Call

```json
{"jsonrpc":"2.0","id":"req-004","method":"tools/call","params":{"name":"provider_list","arguments":{}}}
```

---

### 3.5 `provider_validate`

Validates the active provider without generating an image. The requested provider must match the active provider.

#### Input Schema

| Parameter | Type | Required | Description |
|---|---|---|---|
| `provider` | string | Yes | `openai` or `azure` |

The result contains a short text status and provider-specific `structuredContent`. Basic OpenAI example:

```json
{"valid":true,"provider":"openai"}
```

With Azure Foundry discovery, validation can additionally report the default deployment and discovered deployment metadata (`deployment`, `modelName`, `publisher`, `modelVersion`, and adapter).

#### Example MCP Call

```json
{"jsonrpc":"2.0","id":"req-005","method":"tools/call","params":{"name":"provider_validate","arguments":{"provider":"azure"}}}
```

---

## 4. MCP Protocol Features

This server implements optional MCP protocol features beyond basic tool invocation. The following sections describe when and how each feature is used.

---

### 4.1 Elicitation

**Capability:** `elicitation` (negotiated during `initialize`)

#### When Triggered

Elicitation is used when a required parameter is missing from a tool call and cannot be reasonably inferred. The server sends an `elicitation/create` request to the MCP host, which presents a form to the user.

| Trigger Condition | Tool | Fields Requested |
|-------------------|------|-----------------|
| `prompt` is missing or empty | `image_generate`, `image_edit` | `prompt` (required text) |
| `image` is missing | `image_edit`, `image_variation` | `image` (base64 or URL) |

#### Example `elicitation/create` Request

The server sends this to the MCP host when `prompt` is missing from an `image_generate` call:

```json
{
  "jsonrpc": "2.0",
  "id": "elicit-001",
  "method": "elicitation/create",
  "params": {
    "message": "Please provide a description of the image you'd like to generate.",
    "requestedSchema": {
      "type": "object",
      "properties": {
        "prompt": {
          "type": "string",
          "title": "Image Description",
          "description": "Describe the image you want to create. Be specific about style, subject, and composition.",
          "minLength": 1,
          "maxLength": 32000
        }
      },
      "required": ["prompt"]
    }
  }
}
```

**Elicitation response (from host):**

```json
{
  "jsonrpc": "2.0",
  "id": "elicit-001",
  "result": {
    "action": "accept",
    "content": {
      "prompt": "A serene Japanese garden with a koi pond, cherry blossom trees, and a wooden bridge at sunset"
    }
  }
}
```

**Security note:** Elicitation must never request secrets, API keys, passwords, or any sensitive credentials. See SECURITY.md §6.1.

---

### 4.2 Sampling

**Capability:** `sampling` (negotiated during `initialize`)

#### When Triggered

Sampling is used when the server needs to make an LLM call to assist with a task, such as improving a vague prompt or suggesting appropriate parameters.

| Trigger Condition | Purpose |
|-------------------|---------|
| User prompt is very short (< 10 chars) | Server asks LLM to expand/clarify the prompt |
| Model-specific parameter optimisation | Server asks LLM to recommend `size` and `quality` for the use case |

#### Example `sampling/createMessage` Request

Sent when the server wants LLM assistance expanding a terse prompt:

```json
{
  "jsonrpc": "2.0",
  "id": "sample-001",
  "method": "sampling/createMessage",
  "params": {
    "messages": [
      {
        "role": "user",
        "content": {
          "type": "text",
          "text": "Expand this brief image prompt into a detailed, descriptive prompt for an AI image generator. Return only the improved prompt text, nothing else.\n\nOriginal prompt: \"cat\""
        }
      }
    ],
    "modelPreferences": {
      "hints": [{ "name": "claude-3-5-haiku" }],
      "intelligencePriority": 0.3,
      "speedPriority": 0.9
    },
    "systemPrompt": "You are a helpful assistant that improves image generation prompts. Be specific, descriptive, and artistic. Do not include any harmful or sensitive content.",
    "maxTokens": 256
  }
}
```

**Sampling response (from host):**

```json
{
  "jsonrpc": "2.0",
  "id": "sample-001",
  "result": {
    "role": "assistant",
    "content": {
      "type": "text",
      "text": "A majestic orange tabby cat sitting on a sun-drenched windowsill, looking out at a lush garden, soft natural light illuminating its fur, photorealistic style, shallow depth of field"
    },
    "model": "claude-3-5-haiku-20241022",
    "stopReason": "end_turn"
  }
}
```

**Security note:** Sampling responses are treated as untrusted data and validated before use. See SECURITY.md §6.2.

---

### 4.3 Roots

**Capability:** `roots` (negotiated during `initialize`)

#### When Triggered

The server requests the list of workspace roots when:

1. A tool call includes `save_to_workspace: true` and the server needs to determine allowed save locations.
2. For explicit `workspace_output_path`, roots and all requested output paths are resolved before the provider call (no startup cache).

#### Example `roots/list` Request

```json
{
  "jsonrpc": "2.0",
  "id": "roots-001",
  "method": "roots/list",
  "params": {}
}
```

**Roots response (from host):**

```json
{
  "jsonrpc": "2.0",
  "id": "roots-001",
  "result": {
    "roots": [
      {
        "uri": "file:///home/user/projects/my-project",
        "name": "my-project"
      },
      {
        "uri": "file:///home/user/workspace",
        "name": "workspace"
      }
    ]
  }
}
```

The server uses accepted MCP roots to choose a safe `<workspace>/generated` directory for additional copies. Explicit paths are relative to that directory, not to the root itself.

**Security note:** Workspace destinations are confined to accepted roots; explicit paths are preflighted before the provider call and rechecked before exclusive atomic publication. See SECURITY.md §6.3.

---

## 5. Error Reference

### 5.1 Tool Error Codes

The following error codes appear in tool result `content[0].text` when `isError: true`:

| Error Code | Description | Common Causes |
|------------|-------------|---------------|
| `MISSING_REQUIRED_PARAM` | A required parameter was not provided | `prompt` or `image` omitted |
| `INVALID_PARAM` | A parameter value is invalid or out of range | Wrong `size` for model, `n` out of range, invalid URL scheme |
| `INVALID_FILE_EXTENSION` | File extension not in allowlist | Trying to save as `.exe`, `.sh`, etc. |
| `NULL_BYTE_IN_PATH` | Path contains a null byte character | Potential injection attempt |
| `IMAGE_TOO_LARGE` | Image payload exceeds 20 MB limit | Large base64 input |
| `UNSUPPORTED_IMAGE_FORMAT` | Image format not supported by the selected operation | Non-PNG mask, non-square image for DALL-E 2 variation |
| `UNKNOWN_PROVIDER` | Named provider does not exist | Typo in `provider` field |
| `PROVIDER_NOT_CONFIGURED` | Provider API key is not set | `IMAGE_API_KEY` missing from environment |
| `OPENAI_ERROR` | OpenAI API returned an error | Content policy violation, quota exceeded, invalid key, server error |
| `NETWORK_ERROR` | Network request to provider API failed | DNS failure, timeout, TLS error |
| `NO_WORKSPACE_ROOTS` | `save_to_workspace` requested but no roots granted | MCP host did not grant any workspace roots |
| `SAVE_OUTSIDE_ROOTS` | Save path is not within any granted workspace root | Path resolves outside all root directories |
| `RATE_LIMIT_EXCEEDED` | Client has exceeded the per-minute rate limit | Too many requests from one IP |
| `INTERNAL_ERROR` | Unexpected server error | Bug, unhandled exception — check server logs |

### 5.2 MCP Protocol-Level Errors

These errors are returned at the JSON-RPC level (not inside tool results) and indicate protocol or server issues:

| JSON-RPC Error Code | Message | Description |
|--------------------|---------|-------------|
| `-32700` | Parse error | Request body is not valid JSON |
| `-32600` | Invalid Request | JSON-RPC request structure is malformed |
| `-32601` | Method not found | Requested MCP method does not exist |
| `-32602` | Invalid params | Tool arguments fail schema validation |
| `-32603` | Internal error | Unhandled server-side error |
| `-32001` | Unauthorized | Missing or invalid `IMAGE_MCP_API_KEY` bearer token (HTTP mode) |
| `-32002` | Rate limited | Rate limit exceeded at transport level |
| `-32003` | Tool not found | `tools/call` references a tool name that does not exist |

### 5.3 HTTP Status Codes (HTTP Transport Mode)

| Status | Meaning |
|--------|---------|
| `200 OK` | Request processed (check `isError` in tool result for tool-level errors) |
| `400 Bad Request` | Malformed JSON-RPC request or invalid Host header |
| `401 Unauthorized` | Missing or invalid `Authorization: Bearer` header |
| `429 Too Many Requests` | Rate limit exceeded; see `Retry-After` response header |
| `500 Internal Server Error` | Unhandled server error |
| `503 Service Unavailable` | Server starting up or shutting down |

---

## Appendix A: Tool Capability Matrix

| Feature | `image_generate` | `image_edit` | `image_variation` | `provider_list` | `provider_validate` |
|---------|:-:|:-:|:-:|:-:|:-:|
| Text prompt | ✅ | ✅ | ❌ | ❌ | ❌ |
| Image input | ❌ | ✅ | ✅ | ❌ | ❌ |
| Mask input | ❌ | ✅ | ❌ | ❌ | ❌ |
| Multiple outputs (`n`) | ✅ (1–10) | ✅ (1–10) | ✅ (1–10) | ❌ | ❌ |
| Quality control | ✅ | ✅ | ❌ | ❌ | ❌ |
| Background transparency | ✅ | ❌ | ❌ | ❌ | ❌ |
| Output format selection | ✅ | ✅ | ❌ (PNG only) | ❌ | ❌ |
| Workspace save | ✅ | ✅ | ✅ | ❌ | ❌ |
| Usage tokens returned | ✅ | ✅ | ❌ | ❌ | ❌ |
| Revised prompt returned | ❌ | ❌ | ❌ | ❌ | ❌ |

---

## Appendix B: Model Feature Support

| Feature | `gpt-image-2` | `gpt-image-1.5` | `gpt-image-1-mini` | `gpt-image-1` | `dall-e-2` |
|---------|:-:|:-:|:-:|:-:|:-:|
| `image_generate` | ✅ | ✅ | ✅ | ✅ | ❌ |
| `image_edit` | ✅ | ✅ | ✅ | ✅ | ✅ (PNG, square) |
| `image_variation` | ❌ | ❌ | ❌ | ❌ | ✅ |
| Transparent background | ✅ | ✅ | ✅ | ✅ | ❌ |
| `quality: high/medium/low` | ✅ | ✅ | ✅ | ✅ | ❌ |
| `quality: hd/standard` | ❌ | ❌ | ❌ | ❌ | ❌ |
| Moderation control | ✅ | ✅ | ✅ | ✅ | ❌ |
| Usage token reporting | ✅ | ✅ | ✅ | ✅ | ❌ |
| Auto prompt revision | ❌ | ❌ | ❌ | ❌ | ❌ |
| `n` up to 10 | ✅ | ✅ | ✅ | ✅ | ✅ |
| Azure availability | ✅ Available (no access application needed) | ⚠️ Limited Access | ⚠️ Limited Access | ⚠️ Limited Access | ❌ |

> ~~`dall-e-3`~~ was **retired 2026-03-04** and is no longer available on any provider.

> For Azure, IMAGE_DEPLOYMENT selects the default. Explicit model selection routes the same server between the confirmed MAI-Image-2.5 and gpt-image-2 adapters.

---

*This reference is maintained alongside the schemas and protected by documentation contract tests. For discrepancies, the published tool schema remains authoritative.*

## Azure Foundry deployment discovery

Set IMAGE_FOUNDRY_PROJECT_ENDPOINT to the HTTPS project endpoint ending in /api/projects/<project> to enable runtime deployment discovery through the documented GET /deployments?api-version=v1 API. This is separate from IMAGE_BASE_URL, which remains the inference endpoint, and from IMAGE_API_VERSION.

When enabled, provider_list reports only supported image deployments discovered from the allowlisted metadata pairs Microsoft / MAI-Image-2.5 and OpenAI / gpt-image-2. provider_validate includes deployment name, underlying model name, publisher, model version and adapter. Exact deployment names are deterministic; ambiguous model aliases require an exact deployment unless the configured default is a matching deployment.

image_generate fallback_model=gpt-image-2 explicitly opts into a transparent fallback only when the original model reports an output-stage CONTENT_SAFETY_BLOCK. Prompt-stage blocks never trigger fallback. JSON success output includes requested_model, effective_model, fallback_used and fallback_reason. This does not disable either model safety policy.
## OpenRouter Image API

Use `IMAGE_PROVIDER=openrouter` or the canonical `https://openrouter.ai/api/v1` base URL. The server calls `POST /api/v1/images` and discovers models through `GET /api/v1/images/models`.

| Model | Resolution | Aspect ratios | Input references | n |
|---|---|---|---:|---:|
| `google/gemini-3.1-flash-image` (Nano Banana 2) | `512`, `1K`, `2K`, `4K` | `1:1`, `1:4`, `1:8`, `2:3`, `3:2`, `3:4`, `4:1`, `4:3`, `4:5`, `5:4`, `8:1`, `9:16`, `16:9`, `21:9` | 14 | 1 |
| `microsoft/mai-image-2.5` | omit | `auto`, `1:1`, `4:3`, `3:4`, `16:9`, `9:16`, `3:2`, `2:3` | 1 | 1 |

```json
{"model":"google/gemini-3.1-flash-image","prompt":"Editorial storefront at blue hour","resolution":"2K","aspect_ratio":"16:9","n":1}
```

For image-to-image, use `image_edit`; the provider converts `image` or `images[]` to OpenRouter `input_references`. Masks, `input_fidelity`, and image variation are not supported by this adapter.

## Metrics rename migration

The provider-neutral rename changed the Prometheus prefix from `gpt_image_mcp_` to `image_mcp_` in v0.2.0. Update dashboards and alerts to the new metric names; the old names are not emitted in parallel to avoid double counting.
