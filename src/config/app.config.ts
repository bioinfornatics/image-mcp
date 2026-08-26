import Joi from 'joi';
import { LATEST_MODEL } from './models';

export type ProviderName = 'openai' | 'azure' | 'openrouter' | 'together' | 'custom';
export type AzureAuthMode = 'api_key' | 'azure_cli' | 'on_behalf_of';
export type McpAuthMode = 'none' | 'static_bearer' | 'entra';

export interface AppConfig {
  imageProvider: {
    name: ProviderName;
    apiKey?: string;
    baseUrl: string;
    /** Optional Foundry project endpoint used only for deployment discovery. */
    foundryProjectEndpoint?: string;
    deployment?: string;
    apiVersion: string;
    models: string[];
    azureAuthMode: AzureAuthMode;
    azureTenantId?: string;
    strictDeploymentPinning?: boolean;
  };
  entra: {
    tenantId?: string;
    clientId?: string;
    audience?: string;
    requiredScope: string;
    allowedClientIds: string[];
    clientSecret?: string;
  };
  mcp: {
    transport: 'http' | 'stdio';
    port: number;
    apiKey?: string;
    authMode: McpAuthMode;
    requireMcpAuth: boolean;
    useElicitation: boolean;
    useSampling: boolean;
  };
  defaults: { model: string };
  security: { maxRequestsPerMinute: number };
  logLevel: string;
}

const canonicalAzureMode = (value: unknown): unknown => {
  if (value === 'api-key') return 'api_key';
  if (value === 'az-cli') return 'azure_cli';
  if (value === 'obo') return 'on_behalf_of';
  return value;
};

const canonicalMcpMode = (value: unknown): unknown => {
  if (value === 'static-bearer') return 'static_bearer';
  return value;
};

const schemaShape = {
  IMAGE_MCP_SECRET_BACKEND: Joi.string().valid('file', 'keytar', 'env').optional().default('file'),
  IMAGE_PROVIDER: Joi.string().valid('openai', 'azure', 'openrouter', 'together', 'custom').required().messages({
    'any.required': 'IMAGE_PROVIDER is required (openai|azure|openrouter|together|custom)',
    'any.only': 'IMAGE_PROVIDER must be "openai", "azure", "openrouter", "together", or "custom"',
  }),
  IMAGE_AZURE_AUTH_MODE: Joi.any().custom(canonicalAzureMode).optional(),
  IMAGE_AZURE_TENANT_ID: Joi.string().optional(),
  IMAGE_ENTRA_TENANT_ID: Joi.string().optional(),
  IMAGE_ENTRA_CLIENT_ID: Joi.string().optional(),
  IMAGE_ENTRA_AUDIENCE: Joi.string().optional(),
  IMAGE_ENTRA_SCOPE: Joi.string().optional(),
  IMAGE_ENTRA_ALLOWED_CLIENT_IDS: Joi.string().optional().default(''),
  IMAGE_ENTRA_CLIENT_SECRET: Joi.string().optional(),
  IMAGE_API_KEY: Joi.string().optional(),
  IMAGE_BASE_URL: Joi.when('IMAGE_PROVIDER', {
    switch: [
      { is: 'azure', then: Joi.string().uri().required().messages({ 'any.required': 'IMAGE_BASE_URL is required when IMAGE_PROVIDER=azure (e.g. https://my-resource.openai.azure.com)' }) },
      { is: 'openrouter', then: Joi.string().uri().optional().default('https://openrouter.ai/api/v1') },
      { is: 'custom', then: Joi.string().uri().required().messages({ 'any.required': 'IMAGE_BASE_URL is required when IMAGE_PROVIDER=custom' }) },
    ],
    otherwise: Joi.string().uri().optional(),
  }),
  IMAGE_FOUNDRY_PROJECT_ENDPOINT: Joi.string()
    .uri({ scheme: ['https'] })
    .pattern(/\.services\.ai\.azure\.com\/api\/projects\/[^/]+\/?$/)
    .optional()
    .messages({
      'string.pattern.base': 'IMAGE_FOUNDRY_PROJECT_ENDPOINT must be an HTTPS Foundry project endpoint ending in /api/projects/<project>',
    }),
  IMAGE_DEPLOYMENT: Joi.when('IMAGE_PROVIDER', {
    is: 'azure', then: Joi.string().required().messages({ 'any.required': 'IMAGE_DEPLOYMENT is required when IMAGE_PROVIDER=azure' }), otherwise: Joi.string().optional(),
  }),
  IMAGE_API_VERSION: Joi.string().optional().default('2025-04-01-preview'),
  IMAGE_STRICT_DEPLOYMENT_PINNING: Joi.boolean().optional().default(false),
  IMAGE_MODELS: Joi.string().optional().default('custom'),
  IMAGE_DEFAULT_MODEL: Joi.string().optional().default(LATEST_MODEL),
  PROVIDER: Joi.string().optional(), OPENAI_API_KEY: Joi.string().optional(), OPENAI_BASE_URL: Joi.string().uri().optional(),
  AZURE_OPENAI_ENDPOINT: Joi.string().uri().optional(), AZURE_OPENAI_API_KEY: Joi.string().optional(), AZURE_OPENAI_DEPLOYMENT: Joi.string().optional(), AZURE_OPENAI_API_VERSION: Joi.string().optional(),
  TOGETHER_API_KEY: Joi.string().optional(), CUSTOM_OPENAI_BASE_URL: Joi.string().uri().optional(), CUSTOM_OPENAI_API_KEY: Joi.string().optional(), CUSTOM_OPENAI_MODELS: Joi.string().optional(), DEFAULT_MODEL: Joi.string().optional(),
  IMAGE_MCP_TRANSPORT: Joi.string().valid('http', 'stdio').optional().default('http'),
  IMAGE_PORT: Joi.number().integer().min(1).max(65535).optional().default(3000),
  IMAGE_REQUIRE_MCP_AUTH: Joi.boolean().optional().default(true),
  IMAGE_MCP_AUTH_MODE: Joi.any().custom(canonicalMcpMode).valid('none', 'static_bearer', 'entra').optional(),
  IMAGE_MCP_API_KEY: Joi.string().optional(),
  IMAGE_USE_ELICITATION: Joi.boolean().optional().default(true),
  IMAGE_USE_SAMPLING: Joi.boolean().optional().default(true),
  IMAGE_MAX_REQUESTS_PER_MINUTE: Joi.number().integer().min(1).optional().default(60),
  IMAGE_LOG_LEVEL: Joi.string().valid('debug', 'info', 'warn', 'error').optional().default('info'),
};

export const configValidationSchema = Joi.object(schemaShape).custom((env, helpers) => {
  const provider = env.IMAGE_PROVIDER as ProviderName;
  const azureMode = canonicalAzureMode(env.IMAGE_AZURE_AUTH_MODE ?? (provider === 'azure' && env.IMAGE_API_KEY ? 'api_key' : undefined)) as AzureAuthMode | undefined;
  if (azureMode && !['api_key', 'azure_cli', 'on_behalf_of'].includes(azureMode)) return helpers.error('any.custom', { message: 'IMAGE_AZURE_AUTH_MODE must be api_key, azure_cli, or on_behalf_of' });
  if (provider !== 'azure' && azureMode) return helpers.error('any.custom', { message: 'IMAGE_AZURE_AUTH_MODE is only valid when IMAGE_PROVIDER=azure' });
  if (provider === 'azure' && !azureMode) return helpers.error('any.custom', { message: 'IMAGE_AZURE_AUTH_MODE must be set to api_key or azure_cli when IMAGE_API_KEY is absent; Azure CLI is never inferred automatically' });
  if (provider !== 'azure' && provider !== 'custom' && !env.IMAGE_API_KEY) return helpers.error('any.custom', { message: 'IMAGE_API_KEY is required for the configured IMAGE_PROVIDER' });
  if (azureMode === 'api_key' && !env.IMAGE_API_KEY) return helpers.error('any.custom', { message: 'IMAGE_API_KEY is required when IMAGE_AZURE_AUTH_MODE=api_key' });
  const transport = env.IMAGE_MCP_TRANSPORT as 'http' | 'stdio';
  const mcpMode = (env.IMAGE_MCP_AUTH_MODE ?? (transport === 'stdio' ? 'none' : azureMode === 'on_behalf_of' ? 'entra' : env.IMAGE_REQUIRE_MCP_AUTH === false ? 'none' : 'static_bearer')) as McpAuthMode;
  if (transport === 'stdio' && mcpMode !== 'none') return helpers.error('any.custom', { message: 'IMAGE_MCP_AUTH_MODE must be none for stdio transport' });
  if (azureMode === 'on_behalf_of') {
    if (env.IMAGE_FOUNDRY_PROJECT_ENDPOINT) return helpers.error('any.custom', { message: 'IMAGE_FOUNDRY_PROJECT_ENDPOINT is not supported with on_behalf_of because deployment discovery must not be cached across user identities' });
    if (transport !== 'http' || mcpMode !== 'entra') return helpers.error('any.custom', { message: 'on_behalf_of requires IMAGE_MCP_TRANSPORT=http and IMAGE_MCP_AUTH_MODE=entra' });
    for (const field of ['IMAGE_ENTRA_TENANT_ID', 'IMAGE_ENTRA_CLIENT_ID', 'IMAGE_ENTRA_AUDIENCE', 'IMAGE_ENTRA_CLIENT_SECRET']) {
      if (!env[field]) return helpers.error('any.custom', { message: `${field} is required for on_behalf_of authentication` });
    }
  }
  if (transport === 'http' && mcpMode === 'static_bearer' && (!env.IMAGE_MCP_API_KEY || env.IMAGE_MCP_API_KEY.length < 16)) {
    return helpers.error('any.custom', { message: env.IMAGE_MCP_API_KEY ? 'IMAGE_MCP_API_KEY must be at least 16 characters.' : 'IMAGE_MCP_API_KEY is required for HTTP when IMAGE_MCP_AUTH_MODE=static_bearer' });
  }
  env.IMAGE_AZURE_AUTH_MODE = azureMode;
  env.IMAGE_MCP_AUTH_MODE = mcpMode;
  return env;
}).messages({ 'any.custom': '{{#message}}' });

export const appConfig = (): AppConfig => {
  const provider = (process.env['IMAGE_PROVIDER'] as ProviderName) || 'openai';
  const azureAuthMode = canonicalAzureMode(process.env['IMAGE_AZURE_AUTH_MODE'] ?? (provider === 'azure' && process.env['IMAGE_API_KEY'] ? 'api_key' : 'api_key')) as AzureAuthMode;
  const transport = (process.env['IMAGE_MCP_TRANSPORT'] as 'http' | 'stdio') || 'http';
  const authMode = canonicalMcpMode(process.env['IMAGE_MCP_AUTH_MODE'] ?? (transport === 'stdio' ? 'none' : azureAuthMode === 'on_behalf_of' ? 'entra' : process.env['IMAGE_REQUIRE_MCP_AUTH'] === 'false' ? 'none' : 'static_bearer')) as McpAuthMode;
  return {
    imageProvider: { name: provider, apiKey: process.env['IMAGE_API_KEY'], baseUrl: process.env['IMAGE_BASE_URL'] || (provider === 'openrouter' ? 'https://openrouter.ai/api/v1' : 'https://api.openai.com/v1'), foundryProjectEndpoint: process.env['IMAGE_FOUNDRY_PROJECT_ENDPOINT'], deployment: process.env['IMAGE_DEPLOYMENT'], apiVersion: process.env['IMAGE_API_VERSION'] || '2025-04-01-preview', strictDeploymentPinning: process.env['IMAGE_STRICT_DEPLOYMENT_PINNING'] === 'true', models: (process.env['IMAGE_MODELS'] || 'custom').split(',').map((s) => s.trim()), azureAuthMode, azureTenantId: process.env['IMAGE_AZURE_TENANT_ID'] },
    entra: {
      tenantId: process.env['IMAGE_ENTRA_TENANT_ID'], clientId: process.env['IMAGE_ENTRA_CLIENT_ID'],
      audience: process.env['IMAGE_ENTRA_AUDIENCE'], requiredScope: process.env['IMAGE_ENTRA_SCOPE'] || 'mcp.access',
      allowedClientIds: (process.env['IMAGE_ENTRA_ALLOWED_CLIENT_IDS'] || '').split(',').map((s) => s.trim()).filter(Boolean),
      clientSecret: process.env['IMAGE_ENTRA_CLIENT_SECRET'],
    },
    mcp: { transport, port: parseInt(process.env['IMAGE_PORT'] || '3000', 10), apiKey: process.env['IMAGE_MCP_API_KEY'], authMode, requireMcpAuth: transport === 'http' && authMode === 'static_bearer', useElicitation: process.env['IMAGE_USE_ELICITATION'] !== 'false', useSampling: process.env['IMAGE_USE_SAMPLING'] !== 'false' },
    defaults: { model: process.env['IMAGE_DEFAULT_MODEL'] || LATEST_MODEL }, security: { maxRequestsPerMinute: parseInt(process.env['IMAGE_MAX_REQUESTS_PER_MINUTE'] || '60', 10) }, logLevel: process.env['IMAGE_LOG_LEVEL'] || 'info',
  };
};
