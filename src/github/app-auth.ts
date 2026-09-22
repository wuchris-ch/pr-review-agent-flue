import { createHmac, sign, timingSafeEqual } from 'node:crypto';
import { GitHubClient } from './client.js';

export function validWebhook(body: Buffer, signature: string | undefined, secret: string): boolean {
  if (!signature || !/^sha256=[a-f0-9]{64}$/.test(signature)) return false;
  const expected = createHmac('sha256', secret).update(body).digest();
  return timingSafeEqual(expected, Buffer.from(signature.slice(7), 'hex'));
}

export function appJwt(
  id: string,
  privateKey: string,
  now = Math.floor(Date.now() / 1000),
): string {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iss: id, iat: now - 60, exp: now + 540 })}`;
  return `${unsigned}.${sign('RSA-SHA256', Buffer.from(unsigned), privateKey).toString('base64url')}`;
}

export class AppAuth {
  private readonly tokens = new Map<number, { token: string; expires: number }>();
  constructor(
    private readonly id: string,
    private readonly key: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async identity(): Promise<string> {
    const app = await new GitHubClient(appJwt(this.id, this.key), this.fetchImpl).request<{
      slug: string;
    }>('/app');
    if (!/^[A-Za-z0-9-]+$/.test(app.slug)) throw new Error('invalid GitHub App identity');
    return `${app.slug}[bot]`;
  }

  async token(installation: number): Promise<string> {
    if (!Number.isSafeInteger(installation) || installation < 1)
      throw new Error('invalid installation');
    const cached = this.tokens.get(installation);
    if (cached && cached.expires > Date.now() + 5 * 60_000) return cached.token;
    const result = await new GitHubClient(appJwt(this.id, this.key), this.fetchImpl).request<{
      token: string;
      expires_at: string;
    }>(`/app/installations/${installation}/access_tokens`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        permissions: {
          contents: 'read',
          pull_requests: 'write',
          statuses: 'write',
          issues: 'read',
        },
      }),
    });
    const expires = Date.parse(result.expires_at);
    if (typeof result.token !== 'string' || !Number.isFinite(expires) || expires <= Date.now())
      throw new Error('GitHub App token was not issued');
    if (this.tokens.size >= 100) this.tokens.clear();
    this.tokens.set(installation, { token: result.token, expires });
    return result.token;
  }
}
