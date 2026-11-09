/**
 * A sliding-window counter: at most `max` events in any `windowMs`. In-process and global (it does not look at who
 * is asking, because the only caller identity behind a proxy is a header the caller can forge). Pure: the caller
 * passes the clock.
 */
export class RateWindow {
  private hits: number[] = [];
  private readonly max: number;
  private readonly windowMs: number;

  constructor(max: number, windowMs: number) {
    this.max = max;
    this.windowMs = windowMs;
  }

  /** Records an event and returns true, or returns false (recording nothing) when the window is full. */
  take(nowMs: number): boolean {
    this.hits = this.hits.filter((t) => nowMs - t < this.windowMs);
    if (this.hits.length >= this.max) return false;
    this.hits.push(nowMs);
    return true;
  }

  reset(): void {
    this.hits = [];
  }
}
