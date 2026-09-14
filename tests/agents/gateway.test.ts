import { describe, expect, it, vi } from 'vitest';
import {
  boundedFetch,
  DEFAULT_MAX_OUTPUT_TOKENS,
  DEFAULT_NETWORK_BUDGET_MS,
  DEFAULT_REASONING_EFFORT,
  gatewayConfig,
  MAX_GATEWAY_REQUESTS,
  MAX_RESPONSE_BYTES,
} from '../../src/agents/gateway.js';

const config = {
  MODEL_GATEWAY_API_KEY: 'test-only-key',
  MODEL_GATEWAY_BASE_URL: 'https://gateway.example/v1',
  REVIEW_AGENT_MODEL: 'test-model',
};

describe('model gateway boundary', () => {
  it('requires complete configuration and rejects credentials or insecure remote URLs', () => {
    expect(() => gatewayConfig({})).toThrow(/incomplete/);
    for (const url of [
      'http://gateway.example/v1',
      'https://user:password@gateway.example/v1',
      'https://gateway.example/v1?key=secret',
    ]) {
      expect(() => gatewayConfig({ ...config, MODEL_GATEWAY_BASE_URL: url })).toThrow(
        /requires HTTPS/,
      );
    }
    expect(
      gatewayConfig({ ...config, MODEL_GATEWAY_BASE_URL: 'http://127.0.0.1:1234/v1/' }).baseUrl,
    ).toBe('http://127.0.0.1:1234/v1');
  });

  it('caps actual HTTP requests even when the caller retries', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response('ok'));
    const request = boundedFetch(fetchImpl);
    for (let i = 0; i < MAX_GATEWAY_REQUESTS; i++) {
      await (await request('https://gateway.example')).text();
    }
    await expect(request('https://gateway.example')).rejects.toThrow(/budget/);
    expect(fetchImpl).toHaveBeenCalledTimes(MAX_GATEWAY_REQUESTS);
    expect(fetchImpl.mock.calls[0]?.[1]?.redirect).toBe('error');
  });

  it('discards upstream error bodies and headers but retains retryable status', async () => {
    const request = boundedFetch(
      async () =>
        new Response('private-error-body', {
          status: 503,
          headers: { 'x-private': 'private-header' },
        }),
    );
    const response = await request('https://gateway.example');
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('private-error-body');
    expect(response.headers.has('x-private')).toBe(false);
  });

  it('cuts off oversized streaming responses', async () => {
    const request = boundedFetch(async () => new Response('x'.repeat(MAX_RESPONSE_BYTES + 1)));
    const response = await request('https://gateway.example');
    await expect(response.text()).rejects.toThrow(/safe byte limit/);
  });

  it('defaults the output and request budgets, and accepts operator overrides', () => {
    const defaults = gatewayConfig(config);
    expect(defaults.maxOutputTokens).toBe(DEFAULT_MAX_OUTPUT_TOKENS);
    expect(defaults.networkBudgetMs).toBe(DEFAULT_NETWORK_BUDGET_MS);

    const tuned = gatewayConfig({
      ...config,
      REVIEW_MAX_OUTPUT_TOKENS: '8192',
      REVIEW_GATEWAY_TIMEOUT_SECONDS: '120',
    });
    expect(tuned.maxOutputTokens).toBe(8192);
    expect(tuned.networkBudgetMs).toBe(120_000);

    for (const bad of ['0', '-1', 'many', '999999999']) {
      expect(() => gatewayConfig({ ...config, REVIEW_MAX_OUTPUT_TOKENS: bad })).toThrow(
        /whole numbers/,
      );
    }
  });

  it('keeps the child network budget inside the runtime read timeout', () => {
    // The child waits 200s for a reply, and every attempt it makes shares
    // one network budget that must be able to finish first. Breaking this
    // makes a timeout surface as an unexplained stall instead of a deadline.
    expect(gatewayConfig(config).networkBudgetMs).toBeLessThan(200_000);
  });

  it('shares one time budget across attempts instead of restarting it', async () => {
    // A slow first attempt must not buy a second full-length attempt.
    const slow = vi.fn<typeof fetch>(
      async (_input, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => {
            reject(new Error('aborted'));
          });
        }),
    );
    const request = boundedFetch(slow, { rejected: false }, 60);
    await expect(request('https://gateway.example')).rejects.toThrow();
    await expect(request('https://gateway.example')).rejects.toThrow(/time budget exhausted/);
    expect(slow).toHaveBeenCalledTimes(1);
  });

  it('bounds model thinking by default and accepts an explicit level', () => {
    expect(gatewayConfig(config).reasoningEffort).toBe(DEFAULT_REASONING_EFFORT);
    expect(gatewayConfig({ ...config, REVIEW_REASONING_EFFORT: 'HIGH' }).reasoningEffort).toBe(
      'high',
    );
    // An explicit opt-out hands the choice back to the gateway.
    expect(
      gatewayConfig({ ...config, REVIEW_REASONING_EFFORT: 'default' }).reasoningEffort,
    ).toBeUndefined();
    expect(() => gatewayConfig({ ...config, REVIEW_REASONING_EFFORT: 'maximum' })).toThrow(
      /supported level/,
    );
  });
});
