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

  /** Lets `ms` pass: this clock moves on at once. */
  async elapse(ms: number): Promise<void> {
    this.advance(ms);
  }
}

/**
 * A `FakeClock` that reads the system time: for a fake host whose stamps and markers must be as new as the leases the
 * state ended by its own clock (the CLI's fake host, tests on real timers). `advance` is ignored; `elapse` waits.
 */
export class LiveClock extends FakeClock {
  override now(): number {
    return Date.now();
  }

  override advance(ms: number): void {
    void ms;
  }

  /** Lets `ms` pass by waiting that long: a slow step takes real time, so steps of several processes overlap. */
  override async elapse(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
}
