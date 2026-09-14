import { init } from '@flue/runtime';
import { start } from '@flue/runtime/node';
import { createModelGateway, type GatewayStatus, gatewayConfig } from './gateway.js';
import { ReviewAgent } from './reviewer.js';

const READ_TIMEOUT_MS = 110_000;
const MAX_REPLY_BYTES = 1024 * 1024;

/**
 * The gateway refused the request in a way a retry cannot fix, such as an
 * incomplete configuration, a bad credential, or an unknown model. The
 * caller maps this to a distinct exit code so the parent stops retrying a
 * hopeless setup instead of spending its whole budget on it.
 */
export class GatewayRejectedError extends Error {
  constructor() {
    super('model gateway rejected the request');
    this.name = 'GatewayRejectedError';
  }
}

/** One isolated, process-lifetime conversation per partition and format attempt. */
export async function runFlueReview(input: string): Promise<string> {
  const status: GatewayStatus = { rejected: false };

  let provider: ReturnType<typeof createModelGateway>;
  try {
    provider = createModelGateway(gatewayConfig(), status);
  } catch {
    throw new GatewayRejectedError();
  }

  const runtime = await start({ agents: [ReviewAgent], providers: [provider], env: {} });
  const agent = init(ReviewAgent);

  try {
    const receipt = await agent.dispatch(input);
    const reply = await agent.read(receipt, { signal: AbortSignal.timeout(READ_TIMEOUT_MS) });
    if (!reply.text.trim() || Buffer.byteLength(reply.text) > MAX_REPLY_BYTES) {
      throw new Error('Flue returned empty or oversized output');
    }
    return reply.text;
  } catch {
    await agent.abort().catch(() => undefined);
    // Upstream errors can carry private endpoints or response bodies, so the
    // only detail that escapes is whether retrying could ever help.
    throw status.rejected ? new GatewayRejectedError() : new Error('Flue review failed');
  } finally {
    await runtime.stop();
  }
}
