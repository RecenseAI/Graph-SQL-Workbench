/**
 * Per-connection concurrency and rate limiting. A paginating query can fire a lot of requests
 * at an endpoint that did not ask to be hammered, so both limits are honoured before every call.
 */
export class Limiter {
  private active = 0;
  private queue: (() => void)[] = [];
  /** Timestamps of recent starts, used for the requests-per-second window. */
  private recent: number[] = [];

  constructor(
    private readonly concurrency: number,
    private readonly requestsPerSecond: number,
  ) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private async acquire(): Promise<void> {
    while (this.active >= this.concurrency) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active += 1;
    if (this.requestsPerSecond > 0) {
      for (;;) {
        const now = Date.now();
        this.recent = this.recent.filter((at) => now - at < 1000);
        if (this.recent.length < this.requestsPerSecond) {
          this.recent.push(now);
          return;
        }
        const oldest = this.recent[0] ?? now;
        await new Promise<void>((resolve) => setTimeout(resolve, Math.max(10, 1000 - (now - oldest))));
      }
    }
  }

  private release(): void {
    this.active -= 1;
    const next = this.queue.shift();
    if (next) next();
  }
}

const limiters = new Map<string, { limiter: Limiter; concurrency: number; rps: number }>();

/** One limiter per connection, rebuilt when its settings change. */
export function limiterFor(connectionId: string, concurrency: number, requestsPerSecond: number): Limiter {
  const existing = limiters.get(connectionId);
  if (existing && existing.concurrency === concurrency && existing.rps === requestsPerSecond) {
    return existing.limiter;
  }
  const limiter = new Limiter(concurrency, requestsPerSecond);
  limiters.set(connectionId, { limiter, concurrency, rps: requestsPerSecond });
  return limiter;
}
