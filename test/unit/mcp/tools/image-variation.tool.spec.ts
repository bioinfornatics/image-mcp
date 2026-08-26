import { Test, type TestingModule } from '@nestjs/testing';
import { ImageVariationTool } from '../../../../src/mcp/tools/image-variation.tool';
import { PROVIDER_TOKEN } from '../../../../src/providers/provider.interface';
import type { IImageProvider, ImageResult } from '../../../../src/providers/provider.interface';
import { RootsService } from '../../../../src/mcp/features/roots.service';
import { ImageStorageService } from '../../../../src/mcp/features/image-storage.service';

const mockResult: ImageResult = { b64_json: 'dmFyaWF0aW9u',
  format: 'png',
  mimeType: 'image/png', model: 'dall-e-2', created: 0 };

const VALID_B64 = 'ZmFrZQ==';

describe('ImageVariationTool', () => {
  let tool: ImageVariationTool;
  let mockProvider: jest.Mocked<Pick<IImageProvider, 'variation' | 'name'>>;
  let mockRoots: jest.Mocked<RootsService>;

  const mockServer = { request: jest.fn() };

  const makeModule = async (providerName: 'openai' | 'azure') => {
    mockProvider = { name: providerName, variation: jest.fn() };
    mockRoots = {
      saveImageToWorkspace: jest.fn().mockResolvedValue(null),
      getRoots: jest.fn().mockResolvedValue([]),
    } as unknown as jest.Mocked<RootsService>;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ImageVariationTool,
        { provide: PROVIDER_TOKEN, useValue: mockProvider },
        { provide: RootsService, useValue: mockRoots },
        { provide: ImageStorageService, useValue: { saveImage: jest.fn().mockImplementation((_b64: string, format: string) => Promise.resolve(`/tmp/image-mcp/image.${format}`)) } },
      ],
    }).compile();
    tool = module.get(ImageVariationTool);
  };

  describe('with OpenAI provider', () => {
    beforeEach(() => makeModule('openai'));

    it('should return variation images on success', async () => {
      mockProvider.variation.mockResolvedValue([mockResult]);
      const result = await tool.execute({ image: VALID_B64 });
      expect(result.isError).toBeUndefined();
      expect(result.content).toContainEqual(expect.objectContaining({ type: 'image', data: mockResult.b64_json, mimeType: 'image/png' }));
    });

    it('should propagate provider errors', async () => {
      mockProvider.variation.mockRejectedValue(new Error('dalle2 error'));
      const result = await tool.execute({ image: VALID_B64 });
      expect(result.isError).toBe(true);
    });

    it('should use png MIME type in data URI', async () => {
      mockProvider.variation.mockResolvedValue([mockResult]);
      const result = await tool.execute({ image: VALID_B64 });
      expect(result.content).toContainEqual(expect.objectContaining({ type: 'image', mimeType: 'image/png' }));
    });
  });

  describe('with Azure provider', () => {
    beforeEach(() => makeModule('azure'));

    it('should return error for Azure provider (not supported)', async () => {
      const result = await tool.execute({ image: VALID_B64 });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/azure/i);
    });
  });

  describe('save_to_workspace (H3)', () => {
    beforeEach(async () => {
      await makeModule('openai');
      mockProvider.variation.mockResolvedValue([mockResult]);
    });

    it('should call roots.saveImageToWorkspace when save_to_workspace=true and server provided', async () => {
      mockRoots.saveImageToWorkspace.mockResolvedValue('/workspace/generated/var.png');

      const result = await tool.execute(
        { image: VALID_B64, save_to_workspace: true },
        mockServer,
      );

      expect(mockRoots.saveImageToWorkspace).toHaveBeenCalledTimes(1);
      expect(mockRoots.saveImageToWorkspace).toHaveBeenCalledWith(mockServer, mockResult.b64_json, 'png');
      expect(result.content[0].text).toContain('Saved to');
    });

    it('should include saved path in markdown output', async () => {
      const savedPath = '/workspace/generated/var.png';
      mockRoots.saveImageToWorkspace.mockResolvedValue(savedPath);

      const result = await tool.execute(
        { image: VALID_B64, save_to_workspace: true },
        mockServer,
      );

      expect(result.content[0].text).toContain(savedPath);
      expect(result.content[0].text).toContain(`![Image variation 1](${savedPath})`);
      expect(result.content[0].text).toContain('include each **Display in Goose** Markdown image unchanged');
    });

    it('should expose display_markdown in JSON output', async () => {
      const savedPath = '/workspace/generated/var.png';
      mockRoots.saveImageToWorkspace.mockResolvedValue(savedPath);

      const result = await tool.execute(
        { image: VALID_B64, save_to_workspace: true, response_format: 'json' },
        mockServer,
      );

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.images[0].display_markdown).toBe(`![Image variation 1](${savedPath})`);
    });

    it('should NOT call roots.saveImageToWorkspace when server not provided', async () => {
      await tool.execute({ image: VALID_B64, save_to_workspace: true });
      expect(mockRoots.saveImageToWorkspace).not.toHaveBeenCalled();
    });

    it('should NOT call roots.saveImageToWorkspace when save_to_workspace=false', async () => {
      await tool.execute({ image: VALID_B64, save_to_workspace: false }, mockServer);
      expect(mockRoots.saveImageToWorkspace).not.toHaveBeenCalled();
    });

    it('should not include Saved to in output when save returns null', async () => {
      mockRoots.saveImageToWorkspace.mockResolvedValue(null);

      const result = await tool.execute(
        { image: VALID_B64, save_to_workspace: true },
        mockServer,
      );

      expect(result.content[0].text).toContain('Saved to');
      expect(result.content[0].text).not.toContain('Workspace copy:');
    });
  });

  describe('register() — server closure', () => {
    beforeEach(() => makeModule('openai'));

    it('should pass the inner Server (mcpServer.server) to execute() via closure', async () => {
      mockProvider.variation.mockResolvedValue([mockResult]);

      let capturedServer: unknown;
      const executeSpy = jest.spyOn(tool, 'execute').mockImplementation(async (_p, s) => {
        capturedServer = s;
        return { content: [{ type: 'text' as const, text: '' }] };
      });

      const innerServer = { listRoots: jest.fn().mockResolvedValue({ roots: [] }) };
      const mockMcpServer = {
        server: innerServer,
        registerTool: jest.fn((_name: string, _meta: unknown, handler: (p: unknown) => unknown) => {
          return handler({ image: VALID_B64 });
        }),
      };

      tool.register(mockMcpServer as any);

      // execute() must receive the inner Server, not the McpServer wrapper
      expect(capturedServer).toBe(innerServer);
      executeSpy.mockRestore();
    });
  });
});
