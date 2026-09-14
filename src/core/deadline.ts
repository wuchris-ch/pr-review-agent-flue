/**
 * Wall-clock budgets.
 *
 * The previous runner captured one start time and subtracted elapsed time
 * from a single 120s constant for every partition, so a diff that needed
 * more partitions than the budget allowed always failed part-way through.
 * A `Deadline` makes the distinction explicit: the review owns an overall
 * deadline, and each unit of work derives a bounded child from it.
 */
export class Deadline {
  private constructor(private readonly expiresAt: number) {}

  static in(milliseconds: number): Deadline {
    if (!Number.isFinite(milliseconds) || milliseconds <= 0) {
      throw new RangeError('deadline must be a positive number of milliseconds');
    }
    return new Deadline(Date.now() + milliseconds);
  }

  remainingMs(): number {
    return Math.max(0, this.expiresAt - Date.now());
  }

  expired(): boolean {
    return this.remainingMs() === 0;
  }

  /** A deadline that expires at the sooner of this one and `milliseconds` from now. */
  child(milliseconds: number): Deadline {
    return new Deadline(Math.min(this.expiresAt, Date.now() + milliseconds));
  }

  signal(): AbortSignal {
    return AbortSignal.timeout(Math.max(1, this.remainingMs()));
  }
}
