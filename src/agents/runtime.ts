import { init } from '@flue/runtime';
import { start } from '@flue/runtime/node';
import {
  createModelGateway,
  describeGatewayStatus,
  type GatewayStatus,
  gatewayConfig,
} from './gateway.js';
import { PlatformAgent } from './platform-agent.js';
import { ReviewAgent } from './reviewer.js';

/**
 * How long the child waits for a completed reply.
 *
 * This sits at the top of a nested budget and must exceed the network time
 * the gateway is allowed to spend beneath it, currently
 * `MAX_GATEWAY_REQUESTS` attempts of `requestTimeoutMs` each. The parent's
 * partition timeout in turn exceeds this, so a stuck child is killed by its
 * own deadline rather than by the pool.
 */
const READ_TIMEOUT_MS = 200_000;
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
export async function runFlueReview(
  input: string,
  mode: 'review' | 'platform' = 'review',
): Promise<string> {
  const status: GatewayStatus = { rejected: false };

  let provider: ReturnType<typeof createModelGateway>;
  try {
    provider = createModelGateway(gatewayConfig(), status);
  } catch {
    throw new GatewayRejectedError();
  }

  const definition = mode === 'platform' ? PlatformAgent : ReviewAgent;
  const runtime = await start({ agents: [definition], providers: [provider], env: {} });
  const agent = init(definition);

  try {
    const receipt = await agent.dispatch(input);
    const reply = await agent.read(receipt, { signal: AbortSignal.timeout(READ_TIMEOUT_MS) });
    if (!reply.text.trim()) {
      // A successful call with nothing to show for it means reasoning
      // consumed the entire output budget before the model wrote a reply.
      throw new Error('model produced no reply within its output token budget');
    }
    if (Buffer.byteLength(reply.text) > MAX_REPLY_BYTES) {
      throw new Error('model reply exceeded the safe byte limit');
    }
    return reply.text;
  } catch {
    await agent.abort().catch(() => undefined);
    // Upstream errors can carry private endpoints or response bodies, so the
    // only detail that escapes is a coarse classification: how many attempts
    // were made, the last status code, and whether a retry could ever help.
    if (status.rejected) {
      throw new GatewayRejectedError();
    }
    throw new Error(`Flue review failed (${describeGatewayStatus(status)})`);
  } finally {
    await runtime.stop();
  }
}
