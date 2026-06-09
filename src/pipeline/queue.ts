/** Minimal in-process counting semaphore. Caps concurrent jobs. */
export class Semaphore {
  private permits: number;
  private waiters: Array<() => void> = [];

  constructor(max: number) {
    this.permits = Math.max(1, max);
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) next(); // hand the permit directly to a waiter
    else this.permits++;
  }
}
