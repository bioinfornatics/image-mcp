import { describe, it, expect, mock } from 'bun:test';
import { AzureMultiDeploymentProvider } from '../../../src/providers/azure-multi-deployment.provider';
import type { AppConfig } from '../../../src/config/app.config';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const config: AppConfig['imageProvider'] = {
  name: 'azure', apiKey: 'secret', baseUrl: 'https://unit.services.ai.azure.com',
  deployment: 'MAI-Image-2.5', apiVersion: '2025-04-01-preview', models: [], azureAuthMode: 'api_key',
};
function response(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) } as Response;
}

describe('AzureMultiDeploymentProvider', () => {
  it('uses MAI-Image-2.5 when model is omitted', async () => {
    const fetchImpl = mock(async () => response({ data: [{ b64_json: PNG }] }));
    const provider = new AzureMultiDeploymentProvider({
      config,
      clients: {
        createForDeployment: mock(() => { throw new Error('GPT client should not be created'); }),
        createAuthHeaderProvider: mock(() => async () => ({ name: 'api-key', value: 'secret' })),
      },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const result = await provider.generate({ prompt: 'x', model: '' });
    expect(result[0].model).toBe('MAI-Image-2.5');
    expect((fetchImpl.mock.calls[0] as unknown as [string])[0]).toEndWith('/mai/v1/images/generations');
  });

  it('rejects explicit gpt-image-2 in static single-deployment mode', async () => {
    const createForDeployment = mock(() => ({}));
    const provider = new AzureMultiDeploymentProvider({ config, clients: {
      createForDeployment: createForDeployment as never,
      createAuthHeaderProvider: mock(() => async () => ({ name: 'api-key', value: 'secret' })),
    } });
    expect(provider.availableModels).toEqual(['MAI-Image-2.5']);
    await expect(provider.generate({ prompt: 'x', model: 'gpt-image-2' })).rejects.toThrow(/Static Azure mode/);
    expect(createForDeployment).not.toHaveBeenCalled();
  });

  it('discovers arbitrary deployment names and routes from model publisher metadata', async () => {
    const catalogFetch = mock(async () => response({ value: [
      { name: 'prod-mai-west', modelName: 'MAI-Image-2.5', modelPublisher: 'Microsoft' },
      { name: 'prod-gpt-west', modelName: 'gpt-image-2', modelPublisher: 'OpenAI' },
      { name: 'unsupported', modelName: 'other', modelPublisher: 'Contoso' },
    ] }));
    const generate = mock(async () => ({ data: [{ b64_json: PNG }] }));
    const createForDeployment = mock(() => ({ images: { generate } }));
    const discoveredConfig = {
      ...config, deployment: 'prod-mai-west',
      foundryProjectEndpoint: 'https://unit.services.ai.azure.com/api/projects/project-a',
    };
    const provider = new AzureMultiDeploymentProvider({
      config: discoveredConfig,
      clients: {
        createForDeployment: createForDeployment as never,
        createAuthHeaderProvider: mock(() => async () => ({ name: 'api-key', value: 'secret' })),
      },
      fetchImpl: catalogFetch as unknown as typeof fetch,
    });
    expect(await provider.listAvailableModels()).toEqual(['prod-mai-west', 'prod-gpt-west']);
    await provider.generate({ prompt: 'x', model: 'gpt-image-2', size: '1024x1024' });
    expect(createForDeployment).toHaveBeenCalledWith(discoveredConfig, 'prod-gpt-west');
    expect((catalogFetch.mock.calls[0] as unknown as [string])[0]).toContain('api-version=v1');
  });

  it('rejects ambiguous model aliases and accepts an exact deployment name', async () => {
    const catalogFetch = mock(async () => response({ value: [
      { name: 'gpt-east', modelName: 'gpt-image-2', modelPublisher: 'OpenAI' },
      { name: 'gpt-west', modelName: 'gpt-image-2', modelPublisher: 'OpenAI' },
    ] }));
    const generate = mock(async () => ({ data: [{ b64_json: PNG }] }));
    const createForDeployment = mock(() => ({ images: { generate } }));
    const provider = new AzureMultiDeploymentProvider({
      config: { ...config, deployment: 'MAI-Image-2.5', foundryProjectEndpoint: 'https://unit.services.ai.azure.com/api/projects/p' },
      clients: { createForDeployment: createForDeployment as never,
        createAuthHeaderProvider: mock(() => async () => ({ name: 'api-key', value: 'secret' })) },
      fetchImpl: catalogFetch as unknown as typeof fetch,
    });
    await expect(provider.generate({ prompt: 'x', model: 'gpt-image-2' })).rejects.toThrow(/ambiguous/i);
    await provider.generate({ prompt: 'x', model: 'gpt-west' });
    expect(createForDeployment).toHaveBeenCalledWith(expect.anything(), 'gpt-west');
  });

  it('discovers and routes Microsoft Flash through the MAI endpoint with explicit provenance', async () => {
    const catalogFetch = mock(async (url: string | URL | Request) => String(url).includes('/deployments')
      ? response({ value: [{ name: 'flash-prod', modelName: 'MAI-Image-2.5-Flash', modelPublisher: 'Microsoft' }] })
      : response({ data: [{ b64_json: PNG }] }));
    const provider = new AzureMultiDeploymentProvider({
      config: { ...config, deployment: 'flash-prod', foundryProjectEndpoint: 'https://unit.services.ai.azure.com/api/projects/p' },
      clients: { createForDeployment: mock(() => { throw new Error('wrong adapter'); }),
        createAuthHeaderProvider: mock(() => async () => ({ name: 'api-key', value: 'secret' })) },
      fetchImpl: catalogFetch as unknown as typeof fetch,
    });
    const result = await provider.generate({ prompt: 'x', model: 'MAI-Image-2.5-Flash', size: '1024x1024' });
    expect(result[0]).toEqual(expect.objectContaining({ model: 'MAI-Image-2.5-Flash', provenance: {
      configured_deployment: 'flash-prod', requested_model: 'MAI-Image-2.5-Flash',
      resolved_deployment: 'flash-prod', effective_model: 'MAI-Image-2.5-Flash',
    } }));
    expect((catalogFetch.mock.calls[1] as unknown as [string])[0]).toContain('/mai/v1/images/generations');
  });

  it('rejects deployment overrides before inference when strict pinning is enabled', async () => {
    const createForDeployment = mock(() => ({}));
    const provider = new AzureMultiDeploymentProvider({ config: { ...config, strictDeploymentPinning: true }, clients: {
      createForDeployment: createForDeployment as never,
      createAuthHeaderProvider: mock(() => async () => ({ name: 'api-key', value: 'secret' })),
    } });
    await expect(provider.generate({ prompt: 'x', model: 'gpt-image-2' })).rejects.toThrow(/Strict Azure deployment pinning/);
    expect(createForDeployment).not.toHaveBeenCalled();
  });

  it('rejects unknown models before creating an inference client', async () => {
    const createForDeployment = mock(() => ({}));
    const provider = new AzureMultiDeploymentProvider({
      config,
      clients: {
        createForDeployment: createForDeployment as never,
        createAuthHeaderProvider: mock(() => async () => ({ name: 'api-key', value: 'secret' })),
      },
    });
    await expect(provider.generate({ prompt: 'x', model: 'unknown' })).rejects.toThrow(/Static Azure mode/);
    expect(createForDeployment).not.toHaveBeenCalled();
  });
});
