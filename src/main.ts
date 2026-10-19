#!/usr/bin/env node
// reflect-metadata MUST be the absolute first import.
// NestJS decorators (@Controller, @Post, @Injectable, etc.) call
// Reflect.defineMetadata() at module-load time. If reflect-metadata hasn't
// run yet the decorator crashes with "undefined is not an object".
// This is safe with both `node dist/main.js` and `bun run src/main.ts`
// because Node/Bun process `import` statements sequentially within a file
// before any later imports are resolved.
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { parseCliArgs } from './cli/cli-options';
import { printHelp, printVersion } from './cli/help';
import { withFoundryDefaults } from './config/foundry-endpoint';

/**
 * Dispatches pure, side-effect-free CLI subcommands (--help / --version /
 * --check-config / --show-config-sources) BEFORE any NestJS/secret/keytar
 * initialization. Returns a process exit code when the CLI has fully
 * handled the invocation, or `undefined` to fall through to normal server
 * bootstrap (imports NestJS lazily so plain --help/--version stay instant).
 */
async function dispatchCli(argv: readonly string[]): Promise<number | undefined> {
  const parsed = parseCliArgs(argv);

  if (!parsed.valid) {
    for (const error of parsed.errors) {
      console.error(`Error: ${error}`);
    }
    console.error('');
    printHelp((line) => console.error(line));
    return 1;
  }

  if (parsed.help) {
    printHelp();
    return 0;
  }

  if (parsed.version) {
    printVersion();
    return 0;
  }

  // File flags carry paths only. Apply them before config inspection so
  // --check-config validates the same resolved secret sources as startup.
  if (parsed.apiKeyFile) process.env['IMAGE_API_KEY_FILE'] = parsed.apiKeyFile;
  if (parsed.mcpApiKeyFile) process.env['IMAGE_MCP_API_KEY_FILE'] = parsed.mcpApiKeyFile;

  const overrides = withFoundryDefaults(parsed.overrides, process.env);

  if (parsed.checkConfig || parsed.showConfigSources) {
    // Lazy imports keep --help/--version free of config/secret initialization.
    const { resolveSecrets } = await import('./config/secret-loader');
    const { resolveConfig } = await import('./config/config-resolver');
    await resolveSecrets();
    const resolution = resolveConfig(overrides, process.env);
    const redacted: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(resolution.values)) {
      const isSecret = resolution.provenance[key]?.secret ?? false;
      redacted[key] = isSecret && value ? '***' : value;
    }
    console.log(JSON.stringify({ values: redacted }, null, 2));
    if (parsed.showConfigSources) {
      console.log(JSON.stringify({ provenance: resolution.provenance, diagnostics: resolution.diagnostics }, null, 2));
    }
    return 0;
  }

  if (overrides.provider) process.env['IMAGE_PROVIDER'] = overrides.provider;
  if (overrides.baseUrl) process.env['IMAGE_BASE_URL'] = overrides.baseUrl;
  if (overrides.foundryProjectEndpoint) process.env['IMAGE_FOUNDRY_PROJECT_ENDPOINT'] = overrides.foundryProjectEndpoint;
  if (overrides.deployment) process.env['IMAGE_DEPLOYMENT'] = overrides.deployment;
  if (overrides.defaultModel) process.env['IMAGE_DEFAULT_MODEL'] = overrides.defaultModel;
  if (parsed.overrides.transport) process.env['IMAGE_MCP_TRANSPORT'] = parsed.overrides.transport;
  if (parsed.overrides.port) process.env['IMAGE_PORT'] = parsed.overrides.port;
  if (parsed.overrides.logLevel) process.env['IMAGE_LOG_LEVEL'] = parsed.overrides.logLevel;
  if (parsed.overrides.useElicitation) process.env['IMAGE_USE_ELICITATION'] = parsed.overrides.useElicitation;
  if (parsed.overrides.useSampling) process.env['IMAGE_USE_SAMPLING'] = parsed.overrides.useSampling;

  return undefined;
}

async function bootstrap() {
  if (process.argv[2] === 'auth' && process.argv[3] === 'doctor') {
    await import('./cli/auth-doctor');
    return;
  }

  const cliArgv = process.argv.slice(2);
  const cliExitCode = await dispatchCli(cliArgv);
  if (cliExitCode !== undefined) {
    process.exit(cliExitCode);
  }

  // Lazy imports below: NestJS/reflect-metadata/secret-loader must not be
  // touched for pure CLI subcommands handled above (--help, --version, etc.)
  await import('reflect-metadata');
  const { NestFactory } = await import('@nestjs/core');
  const { FastifyAdapter } = await import('@nestjs/platform-fastify');
  const { hostHeaderValidation, originValidation } = await import('@modelcontextprotocol/fastify');
  const { AppModule } = await import('./app.module');
  const { ConfigService } = await import('@nestjs/config');
  const { Logger } = await import('@nestjs/common');
  const { resolveSecrets } = await import('./config/secret-loader');
  const { getMcpRuntimeConfig, isCompatibleHttpServerRunning } = await import('./config/mcp-runtime.config');

  // Resolve secrets BEFORE NestJS bootstrap so Joi validation sees the real values.
  // Supports: *_FILE env vars (Docker/K8s secrets), OS keychain (keytar), plain env vars.
  await resolveSecrets();

  const logger = new Logger('Bootstrap');

  // In stdio mode stdout is the MCP JSON-RPC wire — any non-JSON bytes break
  // the protocol. Override NestJS ConsoleLogger to write to stderr instead.
  const isStdio = (process.env['IMAGE_MCP_TRANSPORT'] ?? 'http') === 'stdio';

  let nestLogger: any;
  if (isStdio) {
    const { ConsoleLogger } = await import('@nestjs/common');
    class StderrLogger extends ConsoleLogger {
      protected override printMessages(
        messages: unknown[],
        context?: string,
        logLevel?: import('@nestjs/common').LogLevel,
        _writeStreamType?: 'stdout' | 'stderr',
      ) {
        // Force all output to stderr — stdout is reserved for MCP JSON-RPC
        super.printMessages(messages, context, logLevel, 'stderr');
      }
    }
    nestLogger = new StderrLogger();
  } else {
    nestLogger = ['error', 'warn', 'log', 'debug', 'verbose'];
  }

  const adapter = new FastifyAdapter({
    bodyLimit: 50 * 1024 * 1024,
    // Fail closed: arbitrary direct clients must not control forwarded addresses.
    trustProxy: false,
    skipMiddie: true,
  });
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter, {
    logger: nestLogger,
    bufferLogs: false,
  });

  const configService = app.get(ConfigService);
  const { transport, port } = getMcpRuntimeConfig(configService);

  if (transport === 'stdio') {
    // In stdio mode: connect MCP server via stdio transport
    const { McpStdioBootstrap } = await import('./mcp/transport/stdio.bootstrap');
    const bootstrap = app.get(McpStdioBootstrap);
    await app.init();
    await bootstrap.connect();
    logger.log('MCP server running via stdio transport');
  } else {
    // Reuse the official MCP Fastify security hooks while Nest owns the Fastify instance.
    const fastify = adapter.getInstance();
    const allowedHosts = (process.env['IMAGE_HTTP_ALLOWED_HOSTS'] ?? 'localhost,127.0.0.1,[::1]')
      .split(',').map((value) => value.trim()).filter(Boolean);
    const allowedOrigins = (process.env['IMAGE_HTTP_ALLOWED_ORIGINS'] ?? 'localhost,127.0.0.1,[::1]')
      .split(',').map((value) => value.trim()).filter(Boolean);
    // Nest bundles its own compatible Fastify patch release; the hooks are runtime-compatible.
    fastify.addHook('onRequest', hostHeaderValidation(allowedHosts) as never);
    fastify.addHook('onRequest', originValidation(allowedOrigins) as never);

    const host = process.env['IMAGE_HTTP_HOST'] ?? '127.0.0.1';
    if (await isCompatibleHttpServerRunning(host, port)) {
      logger.log(`Reusing compatible MCP server already listening on http://${host}:${port}/mcp`);
      await app.close();
      return;
    }
    try {
      await app.listen(port, host);
    } catch (error: unknown) {
      if (await isCompatibleHttpServerRunning(host, port)) {
        logger.log(`Reusing compatible MCP server already listening on http://${host}:${port}/mcp`);
        await app.close();
        return;
      }
      throw error;
    }
    logger.log(`MCP server listening on http://${host}:${port}/mcp`);
    logger.log(`Health check at http://localhost:${port}/health`);
  }
}

bootstrap().catch((err: unknown) => {
  // Use maskSecret to avoid leaking API keys in startup crash messages
  const msg = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error && err.stack ? err.stack : '';
  // Import is synchronous at this point — sanitise inline
  const masked = msg.replace(/sk-[A-Za-z0-9_-]{20,}/g, 'sk-***')
                    .replace(/Bearer\s+[A-Za-z0-9._-]{16,}/gi, 'Bearer ***')
                    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '***-guid-***')
                    .replace(/\b[A-Za-z0-9]{32,}\b/g, '***');
  console.error('Fatal startup error:', masked);
  if (stack) {
    console.error(stack.replace(/\b[A-Za-z0-9]{32,}\b/g, '***'));
  }
  process.exit(1);
});
