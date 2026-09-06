import { init } from '@flue/runtime';
import { start } from '@flue/runtime/node';
import { ReviewAgent } from './reviewer.js';
import { createModelGateway } from './gateway.js';

/** One isolated, process-lifetime conversation per partition/format attempt. */
export async function runFlueReview(input: string): Promise<string> {
  const runtime = await start({
    agents: [ReviewAgent],
    providers: [createModelGateway()],
    env: {},
  });
  const agent = init(ReviewAgent);
  try {
    const receipt = await agent.dispatch(input);
    const reply = await agent.read(receipt, { signal: AbortSignal.timeout(110_000) });
    if (!reply.text.trim() || Buffer.byteLength(reply.text) > 1024 * 1024) {
      throw new Error('Flue returned empty or oversized output');
    }
    return reply.text;
  } catch {
    await agent.abort().catch(() => undefined);
    throw new Error('Flue review failed');
  } finally {
    await runtime.stop();
  }
}
