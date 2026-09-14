import { describe, expect, it } from 'vitest';
import { mapConcurrent } from '../../src/core/concurrency.js';
import { Deadline } from '../../src/core/deadline.js';

describe('Deadline', () => {
  it('never hands a child more time than the parent has left', () => {
    const parent = Deadline.in(50);
    expect(parent.child(10_000).remainingMs()).toBeLessThanOrEqual(parent.remainingMs());
    expect(parent.child(10).remainingMs()).toBeLessThanOrEqual(10);
  });

  it('reports expiry instead of going negative', async () => {
    const deadline = Deadline.in(5);
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(deadline.remainingMs()).toBe(0);
    expect(deadline.expired()).toBe(true);
  });

  it('rejects a nonsensical budget', () => {
    expect(() => Deadline.in(0)).toThrow(/positive/);
  });
});

describe('mapConcurrent', () => {
  it('preserves input order regardless of completion order', async () => {
    const delays = [30, 5, 20, 1];
    const results = await mapConcurrent(delays, 4, async (delay, index) => {
      await new Promise((resolve) => setTimeout(resolve, delay));
      return index;
    });
    expect(results).toEqual([0, 1, 2, 3]);
  });

  it('never exceeds the configured limit', async () => {
    let inFlight = 0;
    let peak = 0;
    await mapConcurrent(
      Array.from({ length: 12 }, (_, i) => i),
      3,
      async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
      },
    );
    expect(peak).toBe(3);
  });

  it('rejects an invalid limit', async () => {
    await expect(mapConcurrent([1], 0, async () => 1)).rejects.toThrow(/positive integer/);
  });
});
