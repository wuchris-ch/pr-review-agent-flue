import { describe, expect, it, vi } from 'vitest';
import { boundedFetch, gatewayConfig, MAX_RESPONSE_BYTES } from '../../src/agents/gateway.js';

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
    for (let i = 0; i < 3; i++) await (await request('https://gateway.example')).text();
    await expect(request('https://gateway.example')).rejects.toThrow(/budget/);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
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
});
