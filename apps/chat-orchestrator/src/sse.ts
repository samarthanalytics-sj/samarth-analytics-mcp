import type { Response } from 'express';
import type { StreamEvent } from './types.js';

/**
 * Server-Sent Events writer.
 *
 * Buffering is disabled explicitly because nginx buffers proxied responses by default, which would
 * hold every token until the turn finished and make the stream look broken.
 */
export class SseStream {
  private closed = false;
  private readonly heartbeat: NodeJS.Timeout;

  constructor(private readonly res: Response) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();
    // Comment frames keep idle proxies from closing a long tool call.
    this.heartbeat = setInterval(() => {
      if (!this.closed) this.res.write(': ping\n\n');
    }, 15_000);
  }

  send(event: StreamEvent): void {
    if (this.closed) return;
    this.res.write(`data: ${JSON.stringify(event)}\n\n`);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.heartbeat);
    this.res.end();
  }

  get isClosed(): boolean {
    return this.closed;
  }
}
