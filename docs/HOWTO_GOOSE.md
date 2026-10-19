# Use image-mcp with Goose (npx)

This guide targets an end-user computer; no repository clone or Bun installation is required.

## 1. Prerequisites

Install Goose and Node.js 22 or newer (prefer a current LTS release), then verify:

```bash
node --version
npx --version
```

## 2. Add the extension

Edit the Goose configuration file:

- Linux/macOS: `~/.config/goose/config.yaml`
- Windows: `%APPDATA%\Block\goose\config\config.yaml`

Merge one of the following entries under the existing `extensions:` map.

### OpenAI

```yaml
extensions:
  imagemcp:
    enabled: true
    type: stdio
    name: Image MCP
    cmd: npx
    args:
      - "--yes"
      - "@bioinfornatics/image-mcp@0.4.0"
      - --provider
      - openai
      - --transport
      - stdio
    env_keys:
      - IMAGE_API_KEY
    timeout: 300
```

### Microsoft Foundry

Before copying the YAML, collect these values from Foundry:

- resource endpoint: `https://<resource>.services.ai.azure.com`;
- project endpoint: `https://<resource>.services.ai.azure.com/api/projects/<project>`;
- exact deployment name (customer-chosen; it may differ from the model name);
- resource API key.

```yaml
extensions:
  imagemcp:
    enabled: true
    type: stdio
    name: Image MCP
    cmd: npx
    args:
      - "--yes"
      - "@bioinfornatics/image-mcp@0.4.0"
      - --provider
      - azure
      - --base-url
      - https://YOUR-RESOURCE.services.ai.azure.com
      - --foundry-project-endpoint
      - https://YOUR-RESOURCE.services.ai.azure.com/api/projects/YOUR-PROJECT
      - --deployment
      - MAI-Image-2.5
      - --transport
      - stdio
    env_keys:
      - IMAGE_API_KEY
    timeout: 300
```

`IMAGE_API_KEY` is the only secret above. Enter/update it through `goose configure`; do not put its value in `envs` or commit it to `config.yaml`. `IMAGE_MCP_API_KEY` is not needed for `stdio`: it protects the network-facing HTTP transport only.

Note: listing a name under `env_keys` only tells Goose which variable to forward — it does not read your shell's `export`. A shell `export IMAGE_API_KEY=sk-...` alone will not populate it; the value must be entered through `goose configure` (stored in Goose's keyring/config) before it can be resolved. If a secret fails to resolve at launch, re-run `goose configure` for the extension, or `goose auth:doctor` (where available) to diagnose secret resolution.

Restart Goose after changing the extension or its secret.

## 3. Validate before generating

Start a new Goose session and ask:

- OpenAI: **Validate the configured OpenAI provider.**
- Azure: **Validate the configured Azure provider.**

Resolve any key, endpoint, project, or deployment error before spending quota on generation.

Goose may also add its own fields to the saved extension entry (e.g. `cwd`, `bundled`, `available_tools`) when it writes or normalizes `config.yaml`. These are managed by Goose itself — leave them as written; you do not need to set them by hand.

## 4. First image

Start a new Goose session and ask:

> Generate a 1024x1024 PNG of a red fox in a snowy forest.

Expected result:

1. the image is rendered in the conversation;
2. the response contains its saved path;
3. the file exists in the default directory below.

| System | Default image directory |
|---|---|
| Linux | Freedesktop `XDG_PICTURES_DIR/image-mcp`, otherwise `~/Images/image-mcp` |
| macOS | `~/Pictures/image-mcp` |
| Windows | `%USERPROFILE%\Pictures\image-mcp` |

Set `IMAGE_OUTPUT_DIR` under `envs` to override the final directory.

## Troubleshooting

| Symptom | Resolution |
|---|---|
| `npx is not recognized` | Install Node.js LTS, then restart Goose so it receives the updated `PATH`. |
| `Failed to fetch secret IMAGE_API_KEY` | Run `goose configure`, edit the extension, and enter the provider API key. |
| `Failed to fetch secret IMAGE_MODELS` | Remove `IMAGE_MODELS` from `env_keys`; if needed, put its non-secret value in `envs`. |
| `Incorrect API key` / HTTP 401 from provider | Replace `IMAGE_API_KEY` through `goose configure`. |
| npm prints dependency deprecation warnings | Warnings alone are non-blocking; inspect the final `ERROR` line if the extension exits. |
| Running `npx` manually appears to hang | This is normal for an MCP `stdio` process waiting for a client; launch it through Goose. |

## Local clone

For development from a clone, configure Goose with the absolute path to `bin/start.sh`; do not launch an absolute `src/main.ts` path directly. Historical v0.1.3 details are archived in [legacy-v0.1.3.md](troubleshooting/legacy-v0.1.3.md).

## HTTP deployments

HTTP remains secure by default. A server using `IMAGE_MCP_TRANSPORT=http` requires an `IMAGE_MCP_API_KEY` of at least 16 characters unless `IMAGE_REQUIRE_MCP_AUTH=false` is explicitly selected for trusted local-only use.

## Goose references

- [Using Extensions](https://goose-docs.ai/docs/getting-started/using-extensions/)
- [Configuration Files](https://goose-docs.ai/docs/guides/config-files/)
- [CLI Commands](https://goose-docs.ai/docs/guides/goose-cli-commands/)
