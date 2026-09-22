import { createProvider, type Provider, type StreamOptions } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';

/**
 * HTTP attempts allowed per child.
 *
 * Paired with `DEFAULT_REQUEST_TIMEOUT_MS` this bounds the child's total
 * network time, which must stay inside the runtime's read timeout.
 */
export const MAX_GATEWAY_REQUESTS = 2;
export const MAX_RESPONSE_BYTES = 1024 * 1024;
/**
 * Total network time one child may spend, shared across its attempts.
 *
 * A total rather than a per-request ceiling. The reviewer model reasons
 * before answering and its latency has a long tail, so a per-request limit
 * had to be generous enough for the slow case, which then allowed two slow
 * attempts to run back to back and overrun every budget above it. One
 * shared budget keeps a fast failure retryable while a slow first attempt
 * simply spends the time instead of doubling it.
 */
export const DEFAULT_NETWORK_BUDGET_MS = 180_000;
/**
 * Output tokens allowed per reply.
 *
 * Reasoning is billed against this budget and dominates it. A hard
 * partition was measured spending about 15k tokens thinking and 150
 * emitting the review, so the headroom here is deliberate rather than
 * generous. Two earlier values both failed, and differently: at 4096 the
 * object was cut off mid-JSON and the leftover reasoning arrived as prose,
 * and at 16384 reasoning consumed nearly the whole budget and the reply
 * came back empty with an HTTP 200. Measured demand does not expand to fill
 * the ceiling, so raising it costs nothing on easy partitions.
 */
export const DEFAULT_MAX_OUTPUT_TOKENS = 32_768;
/**
 * How much the model may think before answering.
 *
 * The reviewer model reasons by default and bills it against the output
 * budget, which made latency unpredictable: a 1 KB clean diff could spend
 * minutes second-guessing itself and still return nothing, because with no
 * defect to find it kept looking until the budget ran out. Bounding the
 * thinking directly is more predictable than bounding the total, and the
 * evaluation set is what decides whether a given level is good enough.
 */
export const DEFAULT_REASONING_EFFORT = 'low';
const REASONING_EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'default']);
/** Upstream statuses that will not succeed on a retry. */
const NON_RETRYABLE_STATUS = new Set([400, 401, 403, 404, 422]);

export interface GatewayConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  maxOutputTokens: number;
  networkBudgetMs: number;
  /** Undefined leaves the choice to the gateway. */
  reasoningEffort: string | undefined;
}

/**
 * Observations from the gateway boundary that the caller needs after the
 * fact. The child collapses all upstream detail into a generic message, so
 * this flag is how it still reports "retrying will not help".
 */
export interface GatewayStatus {
  rejected: boolean;
  usage?: { inputTokens: number; outputTokens: number };
  /** Upstream attempts actually made, for after-the-fact diagnosis. */
  attempts?: number;
  /** Last upstream HTTP status, when one was received. */
  lastStatus?: number;
  /** True when an attempt was cut off by the shared network budget. */
  timedOut?: boolean;
}

/**
 * A short, non-sensitive description of how the gateway failed.
 *
 * Upstream bodies and endpoints stay inside the child, but the operator
 * still needs to tell a rate limit from a timeout from a bad credential.
 * Only counts, status codes, and flags cross the boundary.
 */
export function describeGatewayStatus(status: GatewayStatus): string {
  const parts = [`attempts=${String(status.attempts ?? 0)}`];
  if (status.lastStatus !== undefined) {
    parts.push(`last_status=${String(status.lastStatus)}`);
  }
  if (status.timedOut) {
    parts.push('network_budget_exhausted');
  }
  if (status.rejected) {
    parts.push('rejected');
  }
  return parts.join(' ');
}

function reasoningEffort(raw: string | undefined): string | undefined {
  const value = raw?.trim().toLowerCase() || DEFAULT_REASONING_EFFORT;
  if (!REASONING_EFFORTS.has(value)) {
    throw new Error('model gateway reasoning effort is not a supported level');
  }
  return value === 'default' ? undefined : value;
}

function positiveInteger(
  raw: string | undefined,
  fallback: number,
  low: number,
  high: number,
): number {
  if (!raw?.trim()) {
    return fallback;
  }
  const value = Number(raw.trim());
  if (!Number.isSafeInteger(value) || value < low || value > high) {
    throw new Error('model gateway limits must be whole numbers inside their supported range');
  }
  return value;
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
  return {
    apiKey,
    baseUrl: url.href.replace(/\/$/, ''),
    model,
    maxOutputTokens: positiveInteger(
      env.REVIEW_MAX_OUTPUT_TOKENS,
      DEFAULT_MAX_OUTPUT_TOKENS,
      1024,
      131_072,
    ),
    reasoningEffort: reasoningEffort(env.REVIEW_REASONING_EFFORT),
    networkBudgetMs:
      positiveInteger(
        env.REVIEW_GATEWAY_TIMEOUT_SECONDS,
        DEFAULT_NETWORK_BUDGET_MS / 1000,
        5,
        600,
      ) * 1000,
  };
}

/** Enforce an actual HTTP budget, including retries initiated by Flue or Pi. */
export function boundedFetch(
  fetchImpl: typeof fetch = fetch,
  status: GatewayStatus = { rejected: false },
  networkBudgetMs: number = DEFAULT_NETWORK_BUDGET_MS,
): typeof fetch {
  let requests = 0;
  let deadline: number | undefined;
  return async (input, options) => {
    if (++requests > MAX_GATEWAY_REQUESTS)
      throw new Error('model gateway request budget exhausted');
    // Starts on first use, so a child is never charged for time spent before
    // it reached the network.
    status.attempts = requests;
    deadline ??= Date.now() + networkBudgetMs;
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      status.timedOut = true;
      throw new Error('model gateway time budget exhausted');
    }
    const signal = AbortSignal.any([
      AbortSignal.timeout(remaining),
      ...(options?.signal ? [options.signal] : []),
    ]);
    let response: Response;
    try {
      response = await fetchImpl(input, { ...options, signal, redirect: 'error' });
    } catch (error) {
      // An abort here is the shared budget expiring, not an upstream fault.
      if (signal.aborted) {
        status.timedOut = true;
      }
      throw error;
    }
    status.lastStatus = response.status;
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
    const decoder = new TextDecoder();
    let pending = '';
    let usage: GatewayStatus['usage'];
    const observe = (chunk: Uint8Array): void => {
      pending += decoder.decode(chunk, { stream: true });
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const value = JSON.parse(line.slice(6)).usage;
          if (
            value &&
            Number.isSafeInteger(value.prompt_tokens) &&
            value.prompt_tokens >= 0 &&
            Number.isSafeInteger(value.completion_tokens) &&
            value.completion_tokens >= 0
          ) {
            usage = { inputTokens: value.prompt_tokens, outputTokens: value.completion_tokens };
          }
        } catch {
          /* Only numeric usage metadata crosses the process boundary. */
        }
      }
    };
    return new Response(
      new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const next = await reader.read();
            if (next.done) {
              if (usage)
                status.usage = {
                  inputTokens: (status.usage?.inputTokens ?? 0) + usage.inputTokens,
                  outputTokens: (status.usage?.outputTokens ?? 0) + usage.outputTokens,
                };
              controller.close();
              return;
            }
            bytes += next.value.byteLength;
            if (bytes > MAX_RESPONSE_BYTES) {
              await reader.cancel();
              controller.error(new Error('model gateway response exceeded the safe byte limit'));
              return;
            }
            observe(next.value);
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
  const request = boundedFetch(fetch, status, config.networkBudgetMs);
  const options = (provided: StreamOptions = {}): StreamOptions => ({
    ...provided,
    fetch: request,
    temperature: 0,
    maxTokens: config.maxOutputTokens,
    timeoutMs: config.networkBudgetMs,
    maxRetries: 0,
    maxRetryDelayMs: 2000,
    cacheRetention: 'none',
    // The runtime and traces only know the public alias, not the private
    // model ID. JSON mode is requested here because it is the only hook that
    // sees the outgoing request body: it drops the markdown fence the model
    // otherwise wraps the object in, and measurably shortens the reasoning
    // the model spends before answering.
    onPayload: (payload) => ({
      ...(payload as Record<string, unknown>),
      model: config.model,
      response_format: { type: 'json_object' },
      ...(config.reasoningEffort === undefined ? {} : { reasoning_effort: config.reasoningEffort }),
    }),
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
        maxTokens: config.maxOutputTokens,
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
