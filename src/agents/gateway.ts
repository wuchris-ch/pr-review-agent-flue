import { createProvider, type Provider, type StreamOptions } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';

export const MAX_GATEWAY_REQUESTS = 3;
export const MAX_RESPONSE_BYTES = 1024 * 1024;
/** Upstream statuses that will not succeed on a retry. */
const NON_RETRYABLE_STATUS = new Set([400, 401, 403, 404, 422]);

export interface GatewayConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

/**
 * Observations from the gateway boundary that the caller needs after the
 * fact. The child collapses all upstream detail into a generic message, so
 * this flag is how it still reports "retrying will not help".
 */
export interface GatewayStatus {
  rejected: boolean;
}

export function gatewayConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const apiKey = env.MODEL_GATEWAY_API_KEY?.trim();
  const baseUrl = env.MODEL_GATEWAY_BASE_URL?.trim();
  const model = env.REVIEW_AGENT_MODEL?.trim();
  if (!apiKey || !baseUrl || !model) throw new Error('model gateway configuration is incomplete');
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error('invalid model gateway URL');
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error('model gateway requires HTTPS or loopback HTTP, without URL credentials');
  }
  return { apiKey, baseUrl: url.href.replace(/\/$/, ''), model };
}

/** Enforce an actual HTTP budget, including retries initiated by Flue or Pi. */
export function boundedFetch(
  fetchImpl: typeof fetch = fetch,
  status: GatewayStatus = { rejected: false },
): typeof fetch {
  let requests = 0;
  return async (input, options) => {
    if (++requests > MAX_GATEWAY_REQUESTS)
      throw new Error('model gateway request budget exhausted');
    const signal = AbortSignal.any([
      AbortSignal.timeout(35_000),
      ...(options?.signal ? [options.signal] : []),
    ]);
    const response = await fetchImpl(input, { ...options, signal, redirect: 'error' });
    if (!response.ok) {
      await response.body?.cancel();
      if (NON_RETRYABLE_STATUS.has(response.status)) {
        status.rejected = true;
      }
      // Keep the status for retry classification, discard private upstream text.
      return new Response(
        JSON.stringify({ error: { message: `model gateway HTTP ${response.status}` } }),
        {
          status: response.status,
          headers: { 'content-type': 'application/json' },
        },
      );
    }
    if (!response.body) throw new Error('model gateway returned no body');
    const reader = response.body.getReader();
    let bytes = 0;
    return new Response(
      new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const next = await reader.read();
            if (next.done) {
              controller.close();
              return;
            }
            bytes += next.value.byteLength;
            if (bytes > MAX_RESPONSE_BYTES) {
              await reader.cancel();
              controller.error(new Error('model gateway response exceeded the safe byte limit'));
              return;
            }
            controller.enqueue(next.value);
          } catch {
            controller.error(new Error('model gateway stream failed'));
          }
        },
        cancel: (reason) => reader.cancel(reason),
      }),
      { status: response.status, headers: response.headers },
    );
  };
}

export function createModelGateway(
  config: GatewayConfig = gatewayConfig(),
  status: GatewayStatus = { rejected: false },
): Provider {
  const api = openAICompletionsApi();
  const request = boundedFetch(fetch, status);
  const options = (provided: StreamOptions = {}): StreamOptions => ({
    ...provided,
    fetch: request,
    temperature: 0,
    maxTokens: 4096,
    timeoutMs: 35_000,
    maxRetries: 0,
    maxRetryDelayMs: 2000,
    cacheRetention: 'none',
    // The runtime and traces only know the public alias, not the private model ID.
    onPayload: (payload) => ({ ...(payload as Record<string, unknown>), model: config.model }),
  });
  return createProvider({
    id: 'model-gateway',
    auth: {
      apiKey: { name: 'Model gateway', resolve: async () => ({ auth: { apiKey: config.apiKey } }) },
    },
    models: [
      {
        id: 'reviewer',
        name: 'Reviewer',
        provider: 'model-gateway',
        api: 'openai-completions',
        baseUrl: config.baseUrl,
        reasoning: false,
        input: ['text'],
        contextWindow: 0,
        maxTokens: 4096,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        compat: {
          supportsStore: false,
          supportsDeveloperRole: false,
          supportsReasoningEffort: false,
          supportsUsageInStreaming: false,
          maxTokensField: 'max_tokens',
        },
      },
    ],
    api: {
      // Preserve the original diff-only capabilities, including no task tool.
      stream: (model, context, supplied) =>
        api.stream(model, { ...context, tools: [] }, options(supplied)),
      streamSimple: (model, context, supplied) =>
        api.streamSimple(model, { ...context, tools: [] }, options(supplied)),
    },
  });
}
