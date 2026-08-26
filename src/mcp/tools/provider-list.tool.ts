import { Injectable, Inject, Logger } from '@nestjs/common';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { PROVIDER_TOKEN } from '../../providers/provider.interface';
import type { IImageProvider } from '../../providers/provider.interface';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../../config/app.config';
import { OPENAI_MODELS, AZURE_MODELS } from '../../config/models';
import { IMAGE_MODEL_CAPABILITIES } from '../../providers/model-capabilities';

@Injectable()
export class ProviderListTool {
  private readonly logger = new Logger(ProviderListTool.name);

  constructor(
    @Inject(PROVIDER_TOKEN) private readonly provider: IImageProvider,
    private readonly configService: ConfigService,
  ) {}

  register(server: McpServer) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (server as any).registerTool(
      'provider_list',
      {
        title: 'List Providers',
        description: `List all configured image generation providers and their status.

Returns: List of providers with name, configuration status, and available models.
Use provider_validate to test connectivity before generating images.`,
        inputSchema: z.object({}),
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async () => this.execute(),
    );
  }

  async execute() {
    const configuredDefault = this.configService.get<AppConfig['defaults']>('defaults')!.model;
    const defaultModel = this.provider.defaultModel ?? this.provider.configuredModel ?? configuredDefault;
    const providerName = this.provider.name;

    const modelsByProvider: Record<string, string[]> = {
      openai: [...OPENAI_MODELS],
      // gpt-image-2 is Public Preview on Azure (no application needed).
      // gpt-image-1.x variants still require limited-access registration.
      openrouter: ['google/gemini-3.1-flash-image', 'microsoft/mai-image-2.5'],
      azure: AZURE_MODELS.map(m =>
        (m === 'gpt-image-1' || m === 'gpt-image-1.5' || m === 'gpt-image-1-mini')
          ? `${m} (limited access)`
          : m,
      ),
      together: [
        'black-forest-labs/FLUX.1-schnell-Free',
        'black-forest-labs/FLUX.1-schnell',
        'black-forest-labs/FLUX.1-dev',
        'black-forest-labs/FLUX.1.1-pro',
      ],
      custom: this.configService.get<AppConfig['imageProvider']>('imageProvider')?.models ?? ['custom'],
    };

    const discoveredModels = this.provider.listAvailableModels
      ? await this.provider.listAvailableModels()
      : undefined;
    const availableModels = discoveredModels
      ? [...discoveredModels]
      : this.provider.availableModels
        ? [...this.provider.availableModels]
        : modelsByProvider[providerName] ?? [];

    const output = {
      configured_provider: providerName,
      default_model: defaultModel,
      providers: [
        {
          name: providerName,
          configured: true,
          available_models: availableModels,
          status: 'configured',
          ...(providerName === 'azure' ? { model_capabilities: IMAGE_MODEL_CAPABILITIES } : {}),
        },
      ],
    };

    const text = [
      `# Configured Providers`,
      ``,
      `**Active Provider:** ${providerName}`,
      `**Default Model:** ${defaultModel}`,
      ``,
      `## ${providerName}`,
      `- Status: configured`,
      `- Available models: ${availableModels.join(', ')}`,
      ...(providerName === 'azure' ? [
        ``,
        `> ✅ **gpt-image-2** is Public Preview — no access application required.`,
        `> ⚠️ **gpt-image-1, gpt-image-1.5, gpt-image-1-mini** require Limited Access registration:`,
        `> apply at https://aka.ms/oai/gptimage1access`,
        `> ⛔ **dall-e-3** was retired 2026-03-04 and is no longer available.`,
      ] : []),
      ...(providerName === 'together' ? [
        ``,
        `> ℹ️ **Together AI**: FLUX models only. No image_edit or image_variation support.`,
        `> Free tier: FLUX.1-schnell-Free (rate limited). Sign up at together.ai`,
      ] : []),
      ...(providerName === 'custom' ? [
        ``,
        `> ℹ️ **Custom endpoint**: Pointing at ${this.configService.get<AppConfig['imageProvider']>('imageProvider')?.baseUrl ?? 'unknown'}`,
        `> Compatibility depends on your endpoint's OpenAI API support.`,
      ] : []),
      ``,
      `Run \`provider_validate\` to test connectivity.`,
    ].join('\n');

    return {
      content: [{ type: 'text' as const, text }],
      structuredContent: output,
    };
  }
}
