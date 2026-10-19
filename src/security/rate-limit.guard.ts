import {
  Injectable,
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { FastifyRequest } from 'fastify';
import type { AppConfig } from '../config/app.config';

// Forwarded addresses are ignored by default (trustProxy: false). Deployments
// behind a load balancer share its IP bucket unless trust is explicitly restricted
// to known proxy addresses; never enable unconditional trust or hop-count trust.

interface RateLimitEntry {
  count: number;
  bytesIn: number;   // running total of estimated payload bytes in window
  windowStart: number;
}

@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly store = new Map<string, RateLimitEntry>();
  private readonly windowMs = 60_000; // 1 minute
  private readonly maxBytesPerWindow = parseInt(
    process.env['IMAGE_MAX_BYTES_PER_MINUTE'] ?? String(50 * 1024 * 1024),
    10,
  );

  constructor(private readonly configService: ConfigService) {}

  private extractRequestBytes(request: FastifyRequest): number {
    // Use Content-Length header if present (fastest)
    const contentLength = request.headers['content-length'];
    if (contentLength) return parseInt(contentLength, 10) || 0;
    // Fallback: estimate from stringified body
    if (request.body) {
      try {
        return Buffer.byteLength(JSON.stringify(request.body), 'utf8');
      } catch {
        return 0;
      }
    }
    return 0;
  }

  canActivate(context: ExecutionContext): boolean {
    const securityConfig = this.configService.get<AppConfig['security']>('security')!;
    const limit = securityConfig.maxRequestsPerMinute;

    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const clientKey = request.ip ?? 'unknown';
    const now = Date.now();
    const requestBytes = this.extractRequestBytes(request);

    // Evict expired entries to prevent unbounded memory growth
    for (const [key, entry] of this.store.entries()) {
      if (now - entry.windowStart > this.windowMs) {
        this.store.delete(key);
      }
    }

    const entry = this.store.get(clientKey);

    if (!entry || now - entry.windowStart > this.windowMs) {
      // New window
      this.store.set(clientKey, { count: 1, bytesIn: requestBytes, windowStart: now });
      return true;
    }

    // Check request count
    if (entry.count >= limit) {
      throw new HttpException(
        {
          jsonrpc: '2.0',
          error: {
            code: -32029,
            message: `Rate limit exceeded: ${limit} requests per minute. Please wait before retrying.`,
          },
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    // Check byte budget
    if ((entry.bytesIn ?? 0) + requestBytes > this.maxBytesPerWindow) {
      throw new HttpException(
        {
          jsonrpc: '2.0',
          error: {
            code: -32029,
            message: `Data rate limit exceeded: maximum ${Math.round(this.maxBytesPerWindow / 1024 / 1024)}MB per minute per client.`,
          },
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    entry.count++;
    entry.bytesIn = (entry.bytesIn ?? 0) + requestBytes;
    return true;
  }
}
