// The clock a host driver reads. Tests hand `FakeHost` a `FakeClock` and move time themselves.

export interface Clock {
  /** Milliseconds since the epoch. */
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

/** A clock that moves only when told to. */
export class FakeClock implements Clock {
  private current: number;

  constructor(start: number = Date.UTC(2026, 9, 22)) {
    this.current = start;
  }

  now(): number {
    return this.current;
  }

  advance(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) throw new Error("a clock only moves forward by a finite number of milliseconds");
    this.current += ms;
  }
}
