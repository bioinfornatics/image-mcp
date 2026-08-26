# ─────────────────────────────────────────────────────────────────────────────
# Stage 1: Build
# ─────────────────────────────────────────────────────────────────────────────
FROM docker.io/oven/bun:1.3.12-alpine AS builder

# Refresh build-stage Alpine libraries as dependencies copied into the runtime
# can retain vulnerable shared-library packages from the base image.
RUN apk upgrade --no-cache

WORKDIR /app

# Install dependencies (cached layer)
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Copy source and build
COPY tsconfig.json tsconfig.build.json ./
COPY src/ ./src/
RUN bun run build
RUN bun install --frozen-lockfile --production

# ─────────────────────────────────────────────────────────────────────────────
# Stage 2: Runtime
# ─────────────────────────────────────────────────────────────────────────────
FROM docker.io/oven/bun:1.3.12-alpine AS runtime

# Refresh Alpine packages so the runtime contains current security fixes even
# when the published Bun base-image digest lags behind the Alpine repository.
RUN apk upgrade --no-cache

WORKDIR /app

# Security: run as non-root user
RUN addgroup --system --gid 1001 mcpgroup && \
    adduser --system --uid 1001 --ingroup mcpgroup mcpuser

# Copy only production artifacts
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./

# Set ownership
RUN chown -R mcpuser:mcpgroup /app

USER mcpuser

# Expose HTTP port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD bun -e "fetch('http://localhost:3000/health/live').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

# Default: HTTP transport
ENV IMAGE_MCP_TRANSPORT=http
ENV IMAGE_PORT=3000
ENV IMAGE_LOG_LEVEL=info

ENTRYPOINT ["bun", "run", "dist/main.js"]
