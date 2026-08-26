import { Test, type TestingModule } from '@nestjs/testing';
import { ImageEditTool } from '../../../../src/mcp/tools/image-edit.tool';
import { PROVIDER_TOKEN } from '../../../../src/providers/provider.interface';
import { ImageProviderError } from '../../../../src/providers/provider.interface';
import type { IImageProvider, ImageResult } from '../../../../src/providers/provider.interface';
import { RootsService } from '../../../../src/mcp/features/roots.service';
import { ImageStorageService } from '../../../../src/mcp/features/image-storage.service';

const mockResult: ImageResult = {
  b64_json: 'ZWRpdGVkaW1hZ2U=',
  format: 'png',
  mimeType: 'image/png',
  model: 'gpt-image-1',
  created: 1_700_000_000,
};

const VALID_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

describe('ImageEditTool', () => {
  let tool: ImageEditTool;
  let mockProvider: jest.Mocked<Pick<IImageProvider, 'edit' | 'name'>>;
  let mockRoots: jest.Mocked<RootsService>;

  const mockServer = { request: jest.fn() };

  beforeEach(async () => {
    mockProvider = { name: 'openai', edit: jest.fn() };
    mockRoots = {
      saveImageToWorkspace: jest.fn().mockResolvedValue(null),
      getRoots: jest.fn().mockResolvedValue([]),
    } as unknown as jest.Mocked<RootsService>;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ImageEditTool,
        { provide: PROVIDER_TOKEN, useValue: mockProvider },
        { provide: RootsService, useValue: mockRoots },
        { provide: ImageStorageService, useValue: { saveImage: jest.fn().mockImplementation((_b64: string, format: string) => Promise.resolve(`/tmp/image-mcp/image.${format}`)) } },
      ],
    }).compile();
    tool = module.get(ImageEditTool);
  });

  describe('Input Validation', () => {
    it('should reject missing image', async () => {
      const result = await tool.execute({ prompt: 'add a hat', image: '' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/validation error/i);
    });

    it('should reject missing prompt', async () => {
      const result = await tool.execute({ image: VALID_B64, prompt: '' });
      expect(result.isError).toBe(true);
    });

    it('should accept valid params without mask', async () => {
      mockProvider.edit.mockResolvedValue([mockResult]);
      const result = await tool.execute({ image: VALID_B64, prompt: 'add a hat' });
      expect(result.isError).toBeUndefined();
    });

    it('should accept valid params with mask', async () => {
      mockProvider.edit.mockResolvedValue([mockResult]);
      const result = await tool.execute({ image: VALID_B64, mask: VALID_B64, prompt: 'add a hat' });
      expect(result.isError).toBeUndefined();
      expect(mockProvider.edit).toHaveBeenCalledWith(
        expect.objectContaining({ mask: VALID_B64 }),
      );
    });

    it('should accept an arbitrary gpt-image-2 WxH size (2048x1152)', async () => {
      mockProvider.edit.mockResolvedValue([mockResult]);
      const result = await tool.execute({ image: VALID_B64, prompt: 'add a hat', size: '2048x1152' });
      expect(result.isError).toBeUndefined();
      expect(mockProvider.edit).toHaveBeenCalledWith(expect.objectContaining({ size: '2048x1152' }));
    });

    it('should reject a non-multiple-of-16 arbitrary size', async () => {
      const result = await tool.execute({ image: VALID_B64, prompt: 'add a hat', size: '1025x1024' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('multiple of 16');
    });

    it('should reject an arbitrary size exceeding the 3:1 ratio', async () => {
      const result = await tool.execute({ image: VALID_B64, prompt: 'add a hat', size: '3088x1024' });
      expect(result.isError).toBe(true);
    });
  });

  describe('Successful Edit', () => {
    beforeEach(() => mockProvider.edit.mockResolvedValue([mockResult]));

    it('should return markdown with base64 data by default', async () => {
      const result = await tool.execute({ image: VALID_B64, prompt: 'add a hat' });
      expect(result.content).toContainEqual(expect.objectContaining({ type: 'image', data: mockResult.b64_json, mimeType: 'image/png' }));
      expect(result.content[0].text).toContain('# Edited Image');
    });

    it('should include a markdown experimental warning for arbitrary sizes above 2560x1440', async () => {
      const result = await tool.execute({ image: VALID_B64, prompt: 'add a hat', size: '2880x2880' });
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('Experimental resolution');
    });

    it('should not include an experimental warning for preset sizes', async () => {
      const result = await tool.execute({ image: VALID_B64, prompt: 'add a hat', size: '1024x1024' });
      expect(result.content[0].text).not.toContain('Experimental');
    });

    it('should include a "warning" field in JSON output for arbitrary sizes above 2560x1440', async () => {
      const result = await tool.execute({ image: VALID_B64, prompt: 'add a hat', size: '2880x2880', response_format: 'json' });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.warning).toContain('Experimental resolution');
    });

    it('should return JSON when response_format=json', async () => {
      const result = await tool.execute({ image: VALID_B64, prompt: 'add a hat', response_format: 'json' });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.images[0].saved_to).toContain('/tmp/image-mcp/');
    });

    it('should pass model through to provider', async () => {
      await tool.execute({ image: VALID_B64, prompt: 'add a hat', model: 'dall-e-2' });
      expect(mockProvider.edit).toHaveBeenCalledWith(expect.objectContaining({ model: 'dall-e-2' }));
    });

    it('should use verified response MIME even when output_format=jpeg was requested', async () => {
      const result = await tool.execute({ image: VALID_B64, prompt: 'add a hat', output_format: 'jpeg' });
      expect(result.content).toContainEqual(expect.objectContaining({ type: 'image', mimeType: 'image/png' }));
    });

    it('should use verified response MIME even when output_format=webp was requested', async () => {
      const result = await tool.execute({ image: VALID_B64, prompt: 'add a hat', output_format: 'webp' });
      expect(result.content).toContainEqual(expect.objectContaining({ type: 'image', mimeType: 'image/png' }));
    });

    it('should default to png MIME type when output_format not set', async () => {
      const result = await tool.execute({ image: VALID_B64, prompt: 'add a hat' });
      expect(result.content).toContainEqual(expect.objectContaining({ type: 'image', mimeType: 'image/png' }));
    });
  });

  describe('Error Handling', () => {
    it('should return isError when provider throws', async () => {
      mockProvider.edit.mockRejectedValue(new Error('API error'));
      const result = await tool.execute({ image: VALID_B64, prompt: 'add a hat' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('API error');
    });

    it('returns the same structured provider error contract as image_generate', async () => {
      mockProvider.edit.mockRejectedValue(new ImageProviderError({
        code: 'CONTENT_SAFETY_BLOCK', message: 'Output candidate filtered.', provider: 'azure',
        model: 'MAI-Image-2.5', retryable: true, stage: 'output', status: 400,
      }));
      const result = await tool.execute({ image: VALID_B64, prompt: 'edit' });
      expect(result.structuredContent).toEqual({ error: expect.objectContaining({
        code: 'CONTENT_SAFETY_BLOCK', max_retries_recommended: 1, image_created: false,
      }) });
    });
  });

  describe('save_to_workspace (H3)', () => {
    beforeEach(() => mockProvider.edit.mockResolvedValue([{ b64_json: 'ZWRpdA==',
  format: 'png',
  mimeType: 'image/png', model: 'gpt-image-1', created: 0 }]));

    it('should call roots.saveImageToWorkspace when save_to_workspace=true and server provided', async () => {
      mockRoots.saveImageToWorkspace.mockResolvedValue('/workspace/generated/img.png');

      const result = await tool.execute(
        { image: VALID_B64, prompt: 'test', save_to_workspace: true },
        mockServer,
      );

      expect(mockRoots.saveImageToWorkspace).toHaveBeenCalledTimes(1);
      expect(result.content[0].text).toContain('Saved to');
    });

    it('should include saved path in markdown output', async () => {
      const savedPath = '/workspace/generated/img.png';
      mockRoots.saveImageToWorkspace.mockResolvedValue(savedPath);

      const result = await tool.execute(
        { image: VALID_B64, prompt: 'test', save_to_workspace: true },
        mockServer,
      );

      expect(result.content[0].text).toContain(savedPath);
      expect(result.content[0].text).toContain(`![Edited image 1](${savedPath})`);
      expect(result.content[0].text).toContain('include each **Display in Goose** Markdown image unchanged');
    });

    it('should expose display_markdown in JSON output', async () => {
      const savedPath = '/workspace/generated/img.png';
      mockRoots.saveImageToWorkspace.mockResolvedValue(savedPath);

      const result = await tool.execute(
        { image: VALID_B64, prompt: 'test', save_to_workspace: true, response_format: 'json' },
        mockServer,
      );

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.images[0].display_markdown).toBe(`![Edited image 1](${savedPath})`);
    });

    it('should NOT call roots.saveImageToWorkspace when server not provided', async () => {
      await tool.execute({ image: VALID_B64, prompt: 'test', save_to_workspace: true });
      expect(mockRoots.saveImageToWorkspace).not.toHaveBeenCalled();
    });

    it('should NOT call roots.saveImageToWorkspace when save_to_workspace=false', async () => {
      await tool.execute({ image: VALID_B64, prompt: 'test', save_to_workspace: false }, mockServer);
      expect(mockRoots.saveImageToWorkspace).not.toHaveBeenCalled();
    });

    it('should not include Saved to in output when save returns null', async () => {
      mockRoots.saveImageToWorkspace.mockResolvedValue(null);

      const result = await tool.execute(
        { image: VALID_B64, prompt: 'test', save_to_workspace: true },
        mockServer,
      );

      expect(result.content[0].text).toContain('Saved to');
      expect(result.content[0].text).not.toContain('Workspace copy:');
    });
  });

  describe('ImageEditTool — multi-image + input_fidelity', () => {
    beforeEach(() => mockProvider.edit.mockResolvedValue([mockResult]));

    it('should pass images[] to provider.edit when provided', async () => {
      const result = await tool.execute({ images: [VALID_B64, VALID_B64], prompt: 'compose' });
      expect(result.isError).toBeUndefined();
      expect(mockProvider.edit).toHaveBeenCalledWith(
        expect.objectContaining({ images: [VALID_B64, VALID_B64] }),
      );
    });

    it('should return isError when aggregate images[] payload exceeds 10MB', async () => {
      // Build a b64 string that decodes to ~6MB so two of them exceed 10MB
      // base64 of N bytes is ceil(N/3)*4 chars; 6MB raw = ~8MB b64 chars
      const sixMbRaw = 6 * 1024 * 1024;
      const bigB64 = 'A'.repeat(Math.ceil(sixMbRaw / 0.75)); // approx b64 length for 6MB decoded
      const result = await tool.execute({ images: [bigB64, bigB64], prompt: 'compose' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/exceeds 10MB aggregate limit/i);
    });

    it('SECURITY: should reject exactly 5 images x 2.5MB each (12.5MB aggregate) as isError', async () => {
      // Exact reproduction of AC3 in gpt-image-mcp-xlh: "5 images × 2.5MB = 12.5MB → isError".
      // base64 char count for N raw bytes ≈ ceil(N/3)*4; the tool's aggregate check
      // approximates raw bytes as raw_b64_length * 0.75, so a 2.5MB-equivalent b64
      // string is ceil(2.5MB / 0.75) characters.
      const twoPointFiveMbRaw = 2.5 * 1024 * 1024;
      const b64Len = Math.ceil(twoPointFiveMbRaw / 0.75);
      const imageB64 = 'A'.repeat(b64Len);
      const images = Array.from({ length: 5 }, () => imageB64);

      const result = await tool.execute({ images, prompt: 'compose 5 images' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/exceeds 10MB aggregate limit/i);
      // Sanity: 5 * 2.5MB = 12.5MB, comfortably over the 10MB cap.
      expect(images.length).toBe(5);
    });

    it('should pass input_fidelity to provider.edit when provided', async () => {
      await tool.execute({ image: VALID_B64, prompt: 'preserve face', input_fidelity: 'high' });
      expect(mockProvider.edit).toHaveBeenCalledWith(
        expect.objectContaining({ input_fidelity: 'high' }),
      );
    });

    it('should return isError when both image and images[] provided', async () => {
      const result = await tool.execute({
        image: VALID_B64,
        images: [VALID_B64],
        prompt: 'edit',
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/validation error/i);
    });

    it('should return isError when neither image nor images[] provided', async () => {
      const result = await tool.execute({ prompt: 'edit' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/validation error/i);
    });
  });

  describe('register() — server closure', () => {
    it('should pass the inner Server (mcpServer.server) to execute() via closure', async () => {
      mockProvider.edit.mockResolvedValue([mockResult]);

      let capturedServer: unknown;
      const executeSpy = jest.spyOn(tool, 'execute').mockImplementation(async (_p, s) => {
        capturedServer = s;
        return { content: [{ type: 'text' as const, text: '' }] };
      });

      const innerServer = { listRoots: jest.fn().mockResolvedValue({ roots: [] }) };
      const mockMcpServer = {
        server: innerServer,
        registerTool: jest.fn((_name: string, _meta: unknown, handler: (p: unknown) => unknown) => {
          return handler({ image: VALID_B64, prompt: 'test' });
        }),
      };

      tool.register(mockMcpServer as any);

      // execute() must receive the inner Server, not the McpServer wrapper
      expect(capturedServer).toBe(innerServer);
      executeSpy.mockRestore();
    });
  });
});
