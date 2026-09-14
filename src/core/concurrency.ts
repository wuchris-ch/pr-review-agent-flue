/**
 * Bounded-concurrency map that preserves input order in its results.
 *
 * Partition reviews used to run strictly serially inside one shared
 * budget, which made large diffs impossible to finish. Running them
 * through a small worker pool keeps the process count bounded while
 * removing the serial latency floor.
 */
export async function mapConcurrent<Input, Output>(
  items: readonly Input[],
  limit: number,
  worker: (item: Input, index: number) => Promise<Output>,
): Promise<Output[]> {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new RangeError('concurrency limit must be a positive integer');
  }

  const results = new Array<Output>(items.length);
  let next = 0;

  const run = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      if (index >= items.length) {
        return;
      }
      results[index] = await worker(items[index] as Input, index);
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}
