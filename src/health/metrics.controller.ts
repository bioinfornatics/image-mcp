import { Controller, Get, Header } from '@nestjs/common';
import { register, collectDefaultMetrics, Counter, Histogram } from 'prom-client';
import { getImageModelCapabilities } from '../providers/model-capabilities';

/** Fixed-cardinality, non-sensitive model family label. */
export function imageModelMetricLabel(model: string | undefined): string {
  if (!model) return 'unknown';
  const capabilities = getImageModelCapabilities(model);
  if (capabilities) return capabilities.family.toLowerCase();
  const canonical = model.toLowerCase();
  if (/^gpt-image-(1|1\.5|1-mini|2)$/.test(canonical) || canonical === 'dall-e-2') return canonical;
  return 'other';
}

// Collect default Node.js metrics (memory, CPU, etc.)
collectDefaultMetrics({ prefix: 'image_mcp_' });

// Custom metrics
export const imageGenerationCounter = new Counter({
  name: 'image_mcp_image_generations_total',
  help: 'Total number of image generation requests',
  labelNames: ['model', 'provider', 'status'],
});

export const imageModelFallbackCounter = new Counter({
  name: 'image_mcp_image_model_fallbacks_total',
  help: 'Total explicit image model fallbacks',
  labelNames: ['from_model', 'to_model', 'reason'],
});

export const imageStageDuration = new Histogram({
  name: 'image_mcp_image_stage_duration_seconds',
  help: 'Image generation stage duration in seconds',
  labelNames: ['stage', 'model', 'provider'],
  buckets: [0.001, 0.01, 0.05, 0.1, 0.5, 1, 5, 30, 120],
});

export const imageGenerationDuration = new Histogram({
  name: 'image_mcp_image_generation_duration_seconds',
  help: 'Image generation request duration in seconds',
  labelNames: ['model', 'provider'],
  buckets: [0.5, 1, 2, 5, 10, 30, 60, 120],
});

export const mcpRequestCounter = new Counter({
  name: 'image_mcp_mcp_requests_total',
  help: 'Total MCP requests received',
  labelNames: ['method', 'status'],
});

export const rateLimitCounter = new Counter({
  name: 'image_mcp_rate_limit_hits_total',
  help: 'Total rate limit rejections',
  labelNames: ['client_ip'],
});

@Controller('metrics')
export class MetricsController {
  @Get()
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  async getMetrics(): Promise<string> {
    return register.metrics();
  }
}
